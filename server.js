require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// 1. FIREBASE AUTH
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

// 2. R2 STORAGE
const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

// 3. OPENAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// 4. MULTER
const upload = multer({ dest: 'uploads/' });

// --- MIDDLEWARE AUTH ---
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        return next();
    } catch (e) {}

    try {
        const response = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Invalid Google Token');
        const userData = await response.json();
        req.user = { uid: userData.sub, email: userData.email };
        return next();
    } catch (error) {
        return res.status(403).json({ error: 'Forbidden' });
    }
};

// ================= ROUTES =================

app.get('/', (req, res) => res.send('✅ VDFY Backend Ready'));

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ЗАВАНТАЖЕННЯ ВІДЕО (+ AI)
app.post('/api/upload-with-ai', verifyToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });

        const newPath = req.file.path + '.webm';
        fs.renameSync(req.file.path, newPath);

        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(newPath),
            model: "whisper-1",
        });

        const fileStream = fs.createReadStream(newPath);
        const folder = req.body.folder || "Unsorted";
        const fileName = `rec_${Date.now()}.webm`;
        
        const userFolder = 'public_uploads'; 
        const r2Key = `${userFolder}/${folder}/${fileName}`;

        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: r2Key,
            Body: fileStream,
            ContentType: "video/webm",
        }));

        const textKey = r2Key.replace('.webm', '.txt');
        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: textKey,
            Body: transcription.text,
            ContentType: "text/plain; charset=utf-8" // Fix for multi-language encoding
        }));

        fs.unlinkSync(newPath);

        res.json({ 
            success: true, 
            publicUrl: `${process.env.R2_PUBLIC_URL}/${r2Key}`,
            transcription: transcription.text
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ОТРИМАННЯ СПИСКУ ВІДЕО ТА ТЕКСТІВ
app.get('/api/my-videos', verifyToken, async (req, res) => {
    try {
        const userFolder = 'public_uploads';
        const command = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: `${userFolder}/`
        });

        const data = await s3.send(command);
        if (!data.Contents) return res.json({ videos: [] });

        const videoFiles = data.Contents.filter(item => item.Key.endsWith('.webm'));
        const allKeys = new Set(data.Contents.map(item => item.Key));

        const videos = videoFiles.map(item => {
            const textKey = item.Key.replace('.webm', '.txt');
            const hasText = allKeys.has(textKey);

            return {
                key: item.Key,
                url: `${process.env.R2_PUBLIC_URL}/${item.Key}`,
                textUrl: hasText ? `${process.env.R2_PUBLIC_URL}/${textKey}` : null,
                uploadedAt: item.LastModified
            };
        });

        videos.sort((a, b) => b.uploadedAt - a.uploadedAt);
        res.json({ videos });
    } catch (error) {
        res.status(500).json({ error: "Failed to list videos" });
    }
});

// 🔥 AI ANALYSIS ENDPOINT
app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const { textUrl } = req.body;
        if (!textUrl) return res.status(400).json({ error: "No text URL" });

        const textRes = await fetch(textUrl);
        const originalText = await textRes.text();

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are a professional analyst. Summarize the provided video transcription into 3-4 key bullet points. Use the same language as the original text." },
                { role: "user", content: originalText }
            ],
        });

        res.json({ analysis: completion.choices[0].message.content });
    } catch (error) {
        console.error("AI Analysis Error:", error);
        res.status(500).json({ error: "AI Analysis failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SUCCESS! Server is listening on 0.0.0.0:${PORT}`); //
});