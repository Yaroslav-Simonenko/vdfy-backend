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
app.use(express.static('public')); 

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}

if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// Очистка назви папки
const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();

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

app.get('/', (req, res) => res.send('✅ Server Ready'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/recorder.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));

// 1. ЗАВАНТАЖЕННЯ (З папками)
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        
        const ownerEmail = req.body.folder; 
        const formName = req.body.subfolder ? sanitize(req.body.subfolder) : "General"; 
        
        // Шлях: users / email / form_name / file
        const emailFolder = (ownerEmail && ownerEmail.includes('@')) ? ownerEmail.replace(/[@.]/g, '_') : "public";
        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.webm`;

        const newPath = req.file.path + '.webm';
        fs.renameSync(req.file.path, newPath);

        const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(newPath), model: "whisper-1" });

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(newPath), ContentType: "video/webm" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.webm', '.txt'), Body: transcription.text, ContentType: "text/plain; charset=utf-8" }));

        fs.unlinkSync(newPath);
        res.json({ publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`, transcription: transcription.text });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. СПИСОК (Визначає папку)
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const email = req.user.email;
    if (!email) return res.json({ videos: [] });
    const emailFolder = email.replace(/[@.]/g, '_');
    
    const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${emailFolder}/` }));
    
    const videos = (data.Contents || []).filter(i => i.Key.endsWith('.webm')).map(i => {
        // Парсимо: users/email/FORM_NAME/file.webm
        const parts = i.Key.split('/');
        const formName = parts.length > 3 ? decodeURIComponent(parts[2]) : "General";

        return {
            key: i.Key,
            url: `${process.env.R2_PUBLIC_URL}/${i.Key}`,
            textUrl: `${process.env.R2_PUBLIC_URL}/${i.Key.replace('.webm', '.txt')}`,
            uploadedAt: i.LastModified,
            formName: formName // Повертаємо назву форми
        };
    });
    res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
});

app.delete('/api/delete-video', verifyToken, async (req, res) => {
    const emailFolder = req.user.email.replace(/[@.]/g, '_');
    if (!req.body.videoKey.startsWith(`users/${emailFolder}/`)) return res.status(403).json({ error: "Access Denied" });
    
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: req.body.videoKey.replace('.webm', '.txt') })).catch(()=>{});
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

app.listen(3000, '0.0.0.0', () => console.log("🚀 Server running"));