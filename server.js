require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg'); // 🔥 Нова бібліотека

const app = express();

// 1. 🔥 Збільшуємо ліміти для великих файлів
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static('public'));

// Налаштування тайм-ауту сервера (10 хвилин), щоб не розривав з'єднання при довгому завантаженні
const server = app.listen(3000, '0.0.0.0', () => console.log("🚀 Server running"));
server.setTimeout(600000); 

// Firebase
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// R2 Storage
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();

// Middleware Auth
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) {
        try {
            const r = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
            req.user = await r.json();
            next();
        } catch { return res.status(403).json({ error: 'Forbidden' }); }
    }
};

app.get('/', (req, res) => res.send('✅ VDFY Server Ready (FFmpeg Enabled)'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/recorder.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));

// 🔥 ФУНКЦІЯ СТИСНЕННЯ ВІДЕО
const compressVideo = (inputPath, outputPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-vcodec libx264', // Кодек
                '-crf 28',         // Рівень стиснення (чим більше, тим менша якість. 28 - оптимально для вебу)
                '-preset veryfast',// Швидкість кодування
                '-acodec aac',     // Аудіо кодек
                '-b:a 128k'        // Бітрейт аудіо
            ])
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
};

// 1. UPLOAD (З компресією)
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    // Збільшуємо тайм-аут для цього конкретного запиту
    req.setTimeout(600000); 
    
    let tempPath = null;
    let compressedPath = null;

    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        
        const ownerEmail = req.body.folder; 
        const formName = req.body.subfolder ? sanitize(req.body.subfolder) : "General"; 
        const emailFolder = (ownerEmail && ownerEmail.includes('@')) ? ownerEmail.replace(/[@.]/g, '_') : "public";
        
        // Оригінальний файл
        tempPath = req.file.path;
        
        // Шлях для стиснутого файлу
        compressedPath = tempPath + '_compressed.mp4'; // Конвертуємо все в mp4 для сумісності

        console.log("⏳ Compressing video...");
        
        // 🔥 ЗАПУСК СТИСНЕННЯ (Якщо це відео)
        // Якщо файл маленький (< 5MB), можна не стискати, але для уніфікації стиснемо все
        await compressVideo(tempPath, compressedPath);
        
        console.log("✅ Compression done. Transcribing...");

        // Транскрибація (використовуємо стиснутий файл - це швидше)
        const transcription = await openai.audio.transcriptions.create({ 
            file: fs.createReadStream(compressedPath), 
            model: "whisper-1" 
        });

        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.mp4`;

        // Завантаження в R2
        await s3.send(new PutObjectCommand({ 
            Bucket: process.env.R2_BUCKET_NAME, 
            Key: r2Key, 
            Body: fs.createReadStream(compressedPath), 
            ContentType: "video/mp4" 
        }));

        // Завантаження тексту
        await s3.send(new PutObjectCommand({ 
            Bucket: process.env.R2_BUCKET_NAME, 
            Key: r2Key.replace('.mp4', '.txt'), 
            Body: transcription.text, 
            ContentType: "text/plain; charset=utf-8" 
        }));

        // Видалення тимчасових файлів
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        res.json({ publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`, transcription: transcription.text });

    } catch (e) { 
        console.error("Upload Error:", e);
        // Чистка при помилці
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.status(500).json({ error: e.message || "Upload failed" }); 
    }
});

// ... (Решта коду LIST, DELETE, ANALYZE - без змін, окрім розширень файлів) ...

// 2. LIST (Оновлений під .mp4)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const email = req.user.email;
    if (!email) return res.json({ videos: [] });
    const emailFolder = email.replace(/[@.]/g, '_');
    
    const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${emailFolder}/` }));
    
    const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4') || i.Key.endsWith('.webm')).map(i => {
        const parts = i.Key.split('/');
        const formName = parts.length > 3 ? decodeURIComponent(parts[2]) : "General";
        return {
            key: i.Key,
            url: `${process.env.R2_PUBLIC_URL}/${i.Key}`,
            textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace(/\.(mp4|webm)$/, '.txt')}`,
            uploadedAt: i.LastModified,
            formName: formName
        };
    });
    res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
});

app.delete('/api/delete-video', verifyToken, async (req, res) => {
    const emailFolder = req.user.email.replace(/[@.]/g, '_');
    if (!req.body.videoKey.startsWith(`users/${emailFolder}/`)) return res.status(403).json({ error: "Access Denied" });
    
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey }));
    // Видаляємо текст незалежно від розширення відео
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey.replace(/\.(mp4|webm)$/, '.txt') })).catch(()=>{});
    res.json({ success: true });
});

app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        const originalText = await textRes.text();
        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "Summarize this." }, { role: "user", content: originalText }]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AI Error" }); }
});