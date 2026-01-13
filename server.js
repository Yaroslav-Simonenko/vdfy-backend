require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}
if (serviceAccount) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// R2
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// Middleware (Только для Админа)
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
            if(!r.ok) throw new Error();
            req.user = await r.json();
            req.user.uid = req.user.sub;
            next();
        } catch { return res.status(403).json({ error: 'Forbidden' }); }
    }
};

// 🔓 ЗАГРУЗКА (SaaS: Клиент шлет видео Автору)
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        
        // folder = UID Автора формы
        const ownerUid = req.body.folder; 
        if (!ownerUid) return res.status(400).json({ error: "Missing Form Owner UID" });

        const newPath = req.file.path + '.webm';
        fs.renameSync(req.file.path, newPath);

        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(newPath), model: "whisper-1" });
        
        // Сохраняем в папку АВТОРА
        const r2Key = `users/${ownerUid}/rec_${Date.now()}.webm`;

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(newPath), ContentType: "video/webm" }));
        await s3.send(new PutObjectCommand({ 
            Bucket: process.env.R2_BUCKET_NAME, 
            Key: r2Key.replace('.webm', '.txt'), 
            Body: transcription.text, 
            ContentType: "text/plain; charset=utf-8" 
        }));

        fs.unlinkSync(newPath);
        res.json({ publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`, transcription: transcription.text });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// 🔒 СПИСОК (Только мои видео)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const myPrefix = `users/${req.user.uid}/`;
        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: myPrefix }));
        
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.webm')).map(i => ({
            key: i.Key,
            url: `${process.env.R2_PUBLIC_URL}/${i.Key}`,
            textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.webm', '.txt')}`,
            uploadedAt: i.LastModified
        }));
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch(e) { res.status(500).json({ error: "List failed" }); }
});

// 🔒 УДАЛЕНИЕ (Только свои)
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    const { videoKey } = req.body;
    if (!videoKey.startsWith(`users/${req.user.uid}/`)) return res.status(403).json({ error: "Access Denied" });
    
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey.replace('.webm', '.txt') })).catch(()=>{});
    res.json({ success: true });
});

// 🔒 АНАЛИЗ
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    const text = await (await fetch(req.body.textUrl)).text();
    const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "Summarize briefly." }, { role: "user", content: text }]
    });
    res.json({ analysis: gpt.choices[0].message.content });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log("🚀 Server running"));