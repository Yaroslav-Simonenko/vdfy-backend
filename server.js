require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Налаштування FFmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

// 👇👇👇 ТВОЯ ПОШТА ГОЛОВНОГО АДМІНА 👇👇👇
const ADMIN_EMAIL = "simonenkoyaroslav2008@gmail.com"; 

// 1. ГЛОБАЛЬНІ НАЛАШТУВАННЯ БЕЗПЕКИ (Для роботи Recorder & SharedArrayBuffer)
app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
});

// Базові налаштування
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Статичні файли (Admin, Dashboard, Recorder)
app.use(express.static('public', { index: false }));

// --- FIREBASE INITIALIZATION ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) { console.warn("No Firebase Key found"); }
}

if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// --- CLOUD STORAGE (R2 / AWS) ---
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

// --- OPENAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- HELPERS ---
const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();

// 🛡️ ЗАХИСТ (Middleware перевірки токена)
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
};

// ==================================================================
// 🔥🔥🔥 МАРШРУТИ СТОРІНОК (HTML) 🔥🔥🔥
// ==================================================================

app.get('/', (req, res) => res.send('✅ VDFY Server Ready (MV3 Compliant)'));

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Recorder: Відкривається за посиланням з Forms
app.get('/r/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'recorder.html'));
});

// Viewer: Перегляд записаного відео
app.get('/v/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));

// Redirector: Якщо старі посилання ще використовуються
app.get('/s/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).send("Link not found");
        if (doc.data().type === 'video') return res.redirect(`/v/${req.params.id}`);
        if (doc.data().type === 'recorder') return res.redirect(`/r/${req.params.id}`);
        res.redirect(doc.data().url);
    } catch (e) { res.status(500).send("Server Error"); }
});

// ==================================================================
// 🔥🔥🔥 API: NEW ARCHITECTURE (MV3 COMPLIANT) 🔥🔥🔥
// ==================================================================

// ✅ 1. СИНХРОНІЗАЦІЯ ЛІНКА (Замість генерації)
// Розширення саме створило ID, ми його просто зберігаємо.
app.post('/api/sync-link', async (req, res) => {
    try {
        const { shortId, email, formName, fullUrl, createdAt } = req.body;

        if (!shortId || !email) return res.status(400).json({ error: "Missing data" });

        await db.collection('shortLinks').doc(shortId).set({
            url: fullUrl,           
            type: 'recorder', 
            email: email, 
            formName: formName || "General", 
            createdAt: createdAt || admin.firestore.FieldValue.serverTimestamp(),
            source: 'local_extension_gen' 
        });

        res.json({ success: true });
    } catch (e) {
        console.error("Sync error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 2. Інфо про лінк (для рекордера, якщо він відкрився без параметрів)
app.get('/api/link-info/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        res.json({ email: doc.data().email, formName: doc.data().formName });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// 3. Завантаження відео + Whisper AI
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    req.setTimeout(600000); // 10 хвилин таймаут
    let tempPath = null, compressedPath = null;
    
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        
        // Отримуємо дані з форми (form-data)
        const ownerEmail = req.body.folder ? req.body.folder.toLowerCase() : "public"; 
        let rawName = req.body.subfolder || "General";
        try { rawName = decodeURIComponent(rawName); } catch(e) {}
        const formName = sanitize(rawName);
        
        const emailFolder = ownerEmail.replace(/[@.]/g, '_');
        
        tempPath = req.file.path;
        compressedPath = tempPath + '_compressed.mp4';

        // Конвертація FFmpeg (для надійності)
        if (req.file.mimetype === 'video/mp4') {
             fs.copyFileSync(tempPath, compressedPath);
        } else {
            await new Promise((resolve, reject) => {
                ffmpeg(tempPath)
                    .outputOptions(['-vcodec libx264', '-crf 28', '-preset veryfast', '-acodec aac', '-b:a 128k'])
                    .save(compressedPath)
                    .on('end', resolve)
                    .on('error', reject);
            });
        }

        // ШІ Транскрибація (Whisper)
        let transcriptionText = "No audio detected or transcription failed.";
        try {
            const transcription = await openai.audio.transcriptions.create({ 
                file: fs.createReadStream(compressedPath), model: "whisper-1" 
            });
            transcriptionText = transcription.text;
        } catch (err) {
            console.error("Whisper Error:", err);
        }

        // Шляхи в R2
        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.mp4`;
        const longUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;

        // Завантаження файлів в R2
        await s3.send(new PutObjectCommand({ 
            Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(compressedPath), ContentType: "video/mp4" 
        }));
        await s3.send(new PutObjectCommand({ 
            Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.mp4', '.txt'), Body: transcriptionText, ContentType: "text/plain; charset=utf-8" 
        }));

        // Створюємо "Public View" лінк (короткий)
        const shortId = Math.random().toString(36).substring(2, 8); // Генеруємо локально
        await db.collection('shortLinks').doc(shortId).set({
            url: longUrl, 
            r2Key: r2Key, 
            type: 'video', 
            email: ownerEmail, 
            formName: formName,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Очистка
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        res.json({ publicUrl: `https://${req.headers.host}/v/${shortId}`, transcription: transcriptionText });

    } catch (e) { 
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.status(500).json({ error: e.message }); 
    }
});

// 4. Отримати список відео (Dashboard/Admin)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const email = req.user.email.toLowerCase();
        let prefix = `users/${email.replace(/[@.]/g, '_')}/`;
        
        // Адмін бачить ВСІ папки
        if (email === ADMIN_EMAIL.toLowerCase()) {
            prefix = `users/`;
        }

        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: prefix }));
        
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4')).map(i => {
            const parts = i.Key.split('/');
            // Структура: users / email_folder / form_name / video.mp4
            return {
                key: i.Key,
                url: `${process.env.R2_PUBLIC_URL}/${i.Key}`, 
                textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.mp4', '.txt')}`,
                uploadedAt: i.LastModified,
                owner: parts.length > 1 ? parts[1].replace(/_/g, '.') : "Unknown",
                formName: parts.length > 2 ? decodeURIComponent(parts[2]) : "General"
            };
        });
        
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch (e) { res.json({ videos: [] }); }
});

// 5. Видалити відео
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const videoKey = req.body.videoKey;
        // Можна додати перевірку, чи належить відео юзеру, але поки що довіряємо токену
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        // Пробуємо видалити текст
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey.replace(/\.(mp4|webm)$/, '.txt') })).catch(()=>{});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. AI Summary (GPT-4o mini)
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        if (!textRes.ok) throw new Error("Text file not found");
        const textContent = await textRes.text();

        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini", 
            messages: [
                { role: "system", content: "Summarize this interview response in 3 bullet points." }, 
                { role: "user", content: textContent }
            ]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AI Analysis Failed" }); }
});

// ==================================================================
// 🔥🔥🔥 API: ADMIN & SOFT BAN 🔥🔥🔥
// ==================================================================

// 1. Отримати всіх користувачів
app.get('/api/admin/users', verifyToken, async (req, res) => {
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).json({ error: "Access Denied" });

    try {
        const listUsersResult = await admin.auth().listUsers(1000);
        
        // Для кожного юзера перевіряємо статус бану в базі
        const usersWithStatus = await Promise.all(listUsersResult.users.map(async (user) => {
            const doc = await db.collection('users').doc(user.uid).get();
            const isBanned = doc.exists && doc.data().isBanned === true;
            
            return {
                uid: user.uid,
                email: user.email,
                disabled: isBanned, // Підміняємо статус auth статусом з бази
                lastSignInTime: user.metadata.lastSignInTime,
                creationTime: user.metadata.creationTime
            };
        }));

        res.json({ users: usersWithStatus });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. SOFT BAN TOGGLE (М'який бан - запис в БД)
app.post('/api/admin/toggle-user', verifyToken, async (req, res) => {
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).send();

    try {
        const { uid, disabled, reason } = req.body; 
        
        // 🔥 ВАЖЛИВО: Ми НЕ використовуємо admin.auth().updateUser для блокування!
        // Ми пишемо в базу даних.

        if (disabled) {
            // БАН
            await db.collection('users').doc(uid).set({ 
                isBanned: true,
                banReason: reason || "Access restricted by admin." 
            }, { merge: true });
        } else {
            // РОЗБАН
            await db.collection('users').doc(uid).update({ 
                isBanned: admin.firestore.FieldValue.delete(),
                banReason: admin.firestore.FieldValue.delete() 
            }).catch(() => {});
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. ПЕРЕВІРКА БАНУ (Публічний API для Dashboard)
app.get('/api/check-ban', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.json({ isBanned: false });

        const user = await admin.auth().getUserByEmail(email);
        
        // Читаємо статус ТІЛЬКИ з бази даних
        const doc = await db.collection('users').doc(user.uid).get();
        
        if (doc.exists && doc.data().isBanned) {
            return res.json({ isBanned: true, reason: doc.data().banReason });
        }
        
        res.json({ isBanned: false });
    } catch (e) {
        // Якщо помилка (юзера нема) - не банимо
        res.json({ isBanned: false });
    }
});

// 4. Видалити юзера (Hard Delete)
app.delete('/api/admin/delete-user', verifyToken, async (req, res) => {
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).send();
    try {
        await admin.auth().deleteUser(req.body.uid);
        // Також бажано почистити базу
        await db.collection('users').doc(req.body.uid).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Запуск
const serverInstance = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 Server running"));
serverInstance.setTimeout(600000);