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

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const ADMIN_EMAIL = "simonenkoyaroslav2008@gmail.com"; 

// ✅ ІЗОЛЯЦІЯ (Тільки для Рекордера)
const enableIsolation = (req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
};

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// --- FIREBASE & CLOUD ---
let serviceAccount;
try { serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : require('./serviceAccountKey.json'); } catch(e) {}
if (serviceAccount && !admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const s3 = new S3Client({
    region: "auto", endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });
const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();

const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = await admin.auth().verifyIdToken(token); next(); } 
    catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
};

// ==================================================================
// 🔥 ВИПРАВЛЕНИЙ ПОРЯДОК МАРШРУТІВ (Це вирішує ваші помилки) 🔥
// ==================================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// 1. RECORDER: Обов'язково з enableIsolation (Вирішує помилку SharedArrayBuffer)
app.get('/recorder.html', enableIsolation, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'recorder.html'));
});
// Підтримка старих посилань
app.get('/r/:id', (req, res) => res.redirect(`/recorder.html#id=${req.params.id}`));

// 2. DASHBOARD & ADMIN: БЕЗ ізоляції (Вирішує проблему чорних відео)
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/watch.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// 3. СТАТИКА: Всі інші файли (css, js, png) віддаємо тут.
// Важливо: це має бути ПІСЛЯ явних маршрутів вище.
app.use(express.static('public', { index: false }));


// ================= API =================

app.post('/api/sync-link', async (req, res) => {
    try {
        const { shortId, email, formName, fullUrl, createdAt } = req.body;

        // 👇 НОВА МАГІЯ: Перевіряємо, чи є юзер у Firebase. Якщо ні — створюємо.
        try {
            await admin.auth().getUserByEmail(email);
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                console.log(`🆕 Creating new user in Firebase: ${email}`);
                const newUser = await admin.auth().createUser({
                    email: email,
                    emailVerified: true,
                    displayName: email.split('@')[0] // Тимчасове ім'я до знака @
                });
                
                // Додаємо запис у Firestore + Гаманець
                await db.collection('users').doc(newUser.uid).set({
                    email: email,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    isBanned: false,
                    balance: 0 // 💰 Створюємо нульовий баланс для нових користувачів
                });
            }
        }
        // 👆 КІНЕЦЬ МАГІЇ

        // Записуємо саме посилання
        await db.collection('shortLinks').doc(shortId).set({
            url: fullUrl, 
            type: 'recorder', 
            email, 
            formName: formName || "General", 
            createdAt: createdAt || admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true });
    } catch (e) { 
        console.error("Sync error:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/api/link-info/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        res.json({ email: doc.data().email, formName: doc.data().formName });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    req.setTimeout(600000); 
    let tempPath = req.file?.path;
    let compressedPath = tempPath + '_compressed.mp4';
    try {
        if (!req.file) throw new Error("No file");
        const ownerEmail = req.body.folder ? req.body.folder.toLowerCase() : "public"; 
        const formName = sanitize(decodeURIComponent(req.body.subfolder || "General"));
        
        // ==========================================================
        // 🔥 БІЛІНГ: ПЕРЕВІРКА БАЛАНСУ ПЕРЕД ОБРОБКОЮ
        // ==========================================================
        let ownerUid = null;
        if (ownerEmail !== "public") {
            try {
                const ownerRecord = await admin.auth().getUserByEmail(ownerEmail);
                ownerUid = ownerRecord.uid;
                const ownerDoc = await db.collection('users').doc(ownerUid).get();
                const balance = ownerDoc.exists && ownerDoc.data().balance ? ownerDoc.data().balance : 0;

                if (balance < 0.5) {
                    // Грошей немає! Видаляємо файл і блокуємо обробку
                    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    console.log(`⛔ Недостатньо коштів у ${ownerEmail} (Баланс: $${balance})`);
                    return res.status(402).json({ error: "Not enough balance. Form owner needs to top up." });
                }
            } catch (error) {
                console.log(`⚠️ Власника форми ${ownerEmail} не знайдено в базі.`);
                if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                return res.status(404).json({ error: "Form owner not found." });
            }
        }
        // ==========================================================

        if (req.file.mimetype === 'video/mp4') fs.copyFileSync(tempPath, compressedPath);
        else await new Promise((resolve, reject) => {
            ffmpeg(tempPath).outputOptions(['-vcodec libx264', '-crf 28', '-preset veryfast', '-acodec aac']).save(compressedPath).on('end', resolve).on('error', reject);
        });

        let transcriptionText = "";
        try {
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(compressedPath),
                model: "whisper-1",
                temperature: 0,
                prompt: "Hello, this is an interview answer. Доброго дня, це відповідь на співбесіду. Start." 
            });
            transcriptionText = transcription.text;
        } catch (e) { 
            console.error("Whisper fail", e); 
        }

        const r2Key = `users/${ownerEmail.replace(/[@.]/g, '_')}/${formName}/rec_${Date.now()}.mp4`;
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(compressedPath), ContentType: "video/mp4" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.mp4', '.txt'), Body: transcriptionText, ContentType: "text/plain" }));

        const shortId = Math.random().toString(36).substring(2, 8); 
        await db.collection('shortLinks').doc(shortId).set({
            url: `${process.env.R2_PUBLIC_URL}/${r2Key}`, type: 'video', email: ownerEmail, formName, 
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // ==========================================================
        // 🔥 БІЛІНГ: СПИСАННЯ ГРОШЕЙ ПІСЛЯ УСПІШНОГО ЗБЕРЕЖЕННЯ
        // ==========================================================
        if (ownerUid) {
            await db.collection('users').doc(ownerUid).set({
                balance: admin.firestore.FieldValue.increment(-0.5)
            }, { merge: true });

            await db.collection('transactions').add({
                invoiceId: `spend_${Date.now()}_${shortId}`,
                uid: ownerUid,
                email: ownerEmail,
                type: 'spend',
                amountUsd: -0.5,
                status: 'success',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Списано $0.5 з балансу ${ownerEmail} за відео ${shortId}`);
        }
        // ==========================================================

        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.json({ publicUrl: `https://${req.headers.host}/v/${shortId}`, transcription: transcriptionText });
    } catch (e) { 
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const email = req.user.email.toLowerCase();
        let prefix = (email === ADMIN_EMAIL.toLowerCase()) ? `users/` : `users/${email.replace(/[@.]/g, '_')}/`;
        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: prefix }));
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4')).map(i => ({
            key: i.Key, url: `${process.env.R2_PUBLIC_URL}/${i.Key}`, 
            textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.mp4', '.txt')}`,
            uploadedAt: i.LastModified, 
            owner: i.Key.split('/')[1]?.replace(/_/g, '.') || "Unknown",
            formName: decodeURIComponent(i.Key.split('/')[2] || "General")
        }));
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch (e) { res.json({ videos: [] }); }
});

app.post('/api/admin/toggle-user', verifyToken, async (req, res) => {
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).send();
    try {
        const { uid, disabled, reason } = req.body;
        if (disabled) await db.collection('users').doc(uid).set({ isBanned: true, banReason: reason }, { merge: true });
        else await db.collection('users').doc(uid).update({ isBanned: admin.firestore.FieldValue.delete() }).catch(()=>{});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/check-ban', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.json({ isBanned: false });
        const user = await admin.auth().getUserByEmail(email);
        const doc = await db.collection('users').doc(user.uid).get();
        if (doc.exists && doc.data().isBanned) return res.json({ isBanned: true, reason: doc.data().banReason });
        res.json({ isBanned: false });
    } catch (e) { res.json({ isBanned: false }); }
});

app.get('/api/admin/users', verifyToken, async (req, res) => {
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).json({ error: "Access Denied" });
    try {
        const listUsersResult = await admin.auth().listUsers(1000);
        const usersWithStatus = await Promise.all(listUsersResult.users.map(async (user) => {
            const doc = await db.collection('users').doc(user.uid).get();
            return {
                uid: user.uid, email: user.email,
                disabled: doc.exists && doc.data().isBanned === true,
                lastSignInTime: user.metadata.lastSignInTime, creationTime: user.metadata.creationTime
            };
        }));
        res.json({ users: usersWithStatus });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const videoKey = req.body.videoKey;
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        const textContent = await textRes.text();

        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    // 🔥 Універсальний промпт, який адаптується під мову кандидата
                    content: "You are a professional HR assistant. Your ONLY task is to analyze the provided interview transcript and write a concise, objective summary of the candidate's answer. STRICT RULES: 1. Do not engage in conversation, do not use greetings or pleasantries. 2. You MUST write the summary in the EXACT SAME LANGUAGE as the provided text. If the text is in English, reply in English. If Ukrainian, reply in Ukrainian, etc." 
                }, 
                { role: "user", content: textContent }
            ]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (error) {
        console.error("AI failed:", error);
        res.status(500).json({ error: "AI Failed" });
    }
});

app.delete('/api/admin/delete-user', verifyToken, async (req, res) => {
    if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).send();
    try {
        await admin.auth().deleteUser(req.body.uid);
        await db.collection('users').doc(req.body.uid).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// ==================== ЗАХИЩЕНИЙ ПЕРЕГЛЯД ВІДЕО ====================

// 1. Віддаємо HTML-сторінку перегляду
app.get('/v/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// 2. API: Перевірка прав доступу і видача відео
app.get('/api/get-secure-video/:id', verifyToken, async (req, res) => {
    try {
        const videoId = req.params.id;
        const requestingUserEmail = req.user.email.toLowerCase(); // Хто запитує

        // Шукаємо запис у базі
        const doc = await db.collection('shortLinks').doc(videoId).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Video not found" });
        }

        const videoData = doc.data();
        const ownerEmail = videoData.email.toLowerCase(); // Власник відео

        console.log(`🔍 Check Access: Request by [${requestingUserEmail}] for video of [${ownerEmail}]`);

        // ⛔ ГОЛОВНА ПЕРЕВІРКА: Якщо імейли не співпадають — БАН
        if (requestingUserEmail !== ownerEmail) {
            return res.status(403).json({ error: "⛔ Access Denied. Only the form creator can view this video." });
        }

        // ✅ Якщо співпадають — віддаємо посилання
        let transcriptionText = "";
        try {
            // Спробуємо дістати текст, якщо він є
            const textUrl = videoData.url.replace('.mp4', '.txt');
            const txtRes = await fetch(textUrl);
            if (txtRes.ok) transcriptionText = await txtRes.text();
        } catch (e) {}

        res.json({
            url: videoData.url,
            transcription: transcriptionText,
            formName: videoData.formName,
            createdAt: videoData.createdAt
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Server error" });
    }
});
// ==================== ФІНАНСИ ТА БАЛАНС ====================

// 1. Отримати поточний баланс користувача
app.get('/api/user/balance', verifyToken, async (req, res) => {
    try {
        const doc = await db.collection('users').doc(req.user.uid).get();
        // Якщо балансу ще немає, віддаємо 0
        const balance = doc.exists && doc.data().balance ? doc.data().balance : 0;
        res.json({ balance });
    } catch (e) {
        console.error("Помилка отримання балансу:", e);
        res.status(500).json({ error: "Не вдалося отримати баланс" });
    }
});

// 2. Ручне поповнення (ТІЛЬКИ ДЛЯ АДМІНА)
app.post('/api/admin/add-balance', async (req, res) => {
    try {
        const { adminKey, email, amount } = req.body;
        
        // Читаємо пароль із безпечних змінних сервера (або використовуємо запасний)
        const SECRET = process.env.ADMIN_SECRET_KEY || "12345";
        if (adminKey !== SECRET) {
            return res.status(403).json({ error: "Невірний пароль адміністратора" });
        }

        if (!email || !amount) {
            return res.status(400).json({ error: "Вкажіть email та суму" });
        }

        let uid;
        try {
            // 🔥 ШУКАЄМО В AUTH, А НЕ В БАЗІ (Це надійніше на 100%)
            const userRecord = await admin.auth().getUserByEmail(email);
            uid = userRecord.uid;
        } catch (error) {
            return res.status(404).json({ error: "Користувача з таким email не знайдено в системі Firebase" });
        }

        const numAmount = parseFloat(amount);

        // 🔥 Оновлюємо баланс. { merge: true } створить запис, якщо його ще не було!
        await db.collection('users').doc(uid).set({
            balance: admin.firestore.FieldValue.increment(numAmount),
            email: email.toLowerCase() // Зберігаємо email для порядку
        }, { merge: true });

        // Записуємо транзакцію для історії
        await db.collection('transactions').add({
            invoiceId: `manual_${Date.now()}`,
            uid: uid,
            email: email.toLowerCase(),
            type: 'manual',
            amountUsd: numAmount,
            status: 'success',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: `Баланс ${email} успішно поповнено на $${numAmount}` });
    } catch (e) {
        console.error("Помилка ручного поповнення:", e);
        res.status(500).json({ error: "Помилка сервера" });
    }
});
const serverInstance = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 Server running"));
serverInstance.setTimeout(600000); 