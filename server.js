require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 ВІДКРИВАЄМО ПАПКУ PUBLIC (для recorder.html)
app.use(express.static('public'));

// Інший маршрут для надійності
app.get('/recorder.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'recorder.html'));
});

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
const sanitizeEmail = (email) => email.replace(/[@.]/g, '_');

// Auth Middleware
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch {
        try {
            const r = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
            req.user = await r.json();
            next();
        } catch { return res.status(403).json({ error: 'Forbidden' }); }
    }
};

app.get('/', (req, res) => res.send('✅ VDFY Server Ready'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// UPLOAD
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const ownerEmail = req.body.folder; 
        const folderName = (ownerEmail && ownerEmail.includes('@')) ? sanitizeEmail(ownerEmail) : "public_uploads";
        
        const newPath = req.file.path + '.webm';
        fs.renameSync(req.file.path, newPath);

        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(newPath), model: "whisper-1" });
        const r2Key = `users/${folderName}/rec_${Date.now()}.webm`;

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(newPath), ContentType: "video/webm" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.webm', '.txt'), Body: transcription.text, ContentType: "text/plain; charset=utf-8" }));

        fs.unlinkSync(newPath);
        res.json({ publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`, transcription: transcription.text });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// LIST
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const email = req.user.email;
    if (!email) return res.json({ videos: [] });
    const folderName = sanitizeEmail(email);
    const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${folderName}/` }));
    const videos = (data.Contents || []).filter(i => i.Key.endsWith('.webm')).map(i => ({
        key: i.Key, url: `${process.env.R2_PUBLIC_URL}/${i.Key}`,
        textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.webm', '.txt')}`,
        uploadedAt: i.LastModified
    }));
    res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
});

// DELETE
app.delete('/api/delete-video', verifyToken, async (req, res) => {
    const folderName = sanitizeEmail(req.user.email);
    if (!req.body.videoKey.startsWith(`users/${folderName}/`)) return res.status(403).json({ error: "Access Denied" });
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey.replace('.webm', '.txt') })).catch(()=>{});
    res.json({ success: true });
});

// ANALYZE
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    const text = await (await fetch(req.body.textUrl)).text();
    const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "Summarize this." }, { role: "user", content: text }]
    });
    res.json({ analysis: gpt.choices[0].message.content });
});

app.listen(3000, '0.0.0.0', () => console.log("🚀 Server running"));