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
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static('public'));

const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log("🚀 Server running"));
server.setTimeout(600000); 

// --- CONFIG ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    try { serviceAccount = require('./serviceAccountKey.json'); } catch(e) {}
}
if (serviceAccount) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

const sanitize = (str) => str.replace(/[^a-zA-Z0-9а-яА-ЯёЁіІїЇєЄ\-_ ]/g, '').trim();
const generateShortId = () => Math.random().toString(36).substring(2, 7);
const generatePassword = (length = 8) => {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let retVal = "";
    for (let i = 0, n = charset.length; i < length; ++i) {
        retVal += charset.charAt(Math.floor(Math.random() * n));
    }
    return retVal;
};

const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        next();
    } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
};

// --- ROUTES ---

app.get('/', (req, res) => res.send('✅ VDFY Server Ready'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// 🔥 1. CLEAN RECORDER LINK (/r/xxxxx)
app.get('/r/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'recorder.html'));
});

// Fallback logic
app.get('/recorder.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recorder.html')));

// 🔥 2. SHORT LINK REDIRECT (/s/xxxxx -> Video or Recorder)
app.get('/s/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).send("Link not found");
        
        if (doc.data().type === 'video') return res.redirect(`/v/${req.params.id}`);
        res.redirect(doc.data().url);
    } catch (e) { res.status(500).send("Server Error"); }
});

// 3. VIDEO WATCH PAGE
app.get('/v/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));

// 🔥 4. API: CREATE SHORT LINK (Smart)
app.post('/api/shorten', async (req, res) => {
    try {
        const { type, email, formName, longUrl } = req.body;
        const shortId = generateShortId();
        const host = `${req.protocol}://${req.get('host')}`; 

        let finalUrl = "";
        
        if (type === 'recorder') {
            // Зберігаємо параметри в базі, щоб не світити в URL
            await db.collection('shortLinks').doc(shortId).set({
                type: 'recorder',
                email: email,       
                formName: formName, 
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            finalUrl = `${host}/r/${shortId}`;
        } else {
            // Звичайне скорочення
            await db.collection('shortLinks').doc(shortId).set({
                url: longUrl, type: 'general', createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            finalUrl = `${host}/s/${shortId}`;
        }

        res.json({ shortUrl: finalUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🔥 5. API: GET LINK INFO (For Recorder)
app.get('/api/link-info/:id', async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        res.json({ 
            email: doc.data().email, 
            formName: doc.data().formName 
        });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

// 6. API: GET SECURE VIDEO (For Watch Page)
app.get('/api/get-secure-video/:id', verifyToken, async (req, res) => {
    try {
        const doc = await db.collection('shortLinks').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: "Not found" });
        
        const data = doc.data();
        const requester = req.user.email.toLowerCase();
        const owner = data.email ? data.email.toLowerCase() : "";

        if (requester !== owner) return res.status(403).json({ error: "Access Denied" });
        
        res.json({ url: data.url, transcription: data.transcription || "" });
    } catch (e) { res.status(500).json({ error: "Server Error" }); }
});

// 7. API: UPLOAD WITH AI
app.post('/api/upload-with-ai', upload.single('file'), async (req, res) => {
    req.setTimeout(600000); 
    let tempPath = null, compressedPath = null;
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const ownerEmail = req.body.folder ? req.body.folder.toLowerCase() : "public"; 
        const formName = req.body.subfolder ? sanitize(req.body.subfolder) : "General"; 
        const emailFolder = ownerEmail.replace(/[@.]/g, '_');
        
        tempPath = req.file.path;
        compressedPath = tempPath + '_compressed.mp4';

        await new Promise((resolve, reject) => {
            ffmpeg(tempPath).outputOptions(['-vcodec libx264', '-crf 28', '-preset veryfast', '-acodec aac', '-b:a 128k'])
                .save(compressedPath).on('end', resolve).on('error', reject);
        });

        const transcription = await openai.audio.transcriptions.create({ 
            file: fs.createReadStream(compressedPath), model: "whisper-1",
            prompt: "Video response. Languages: Ukrainian, Russian, English." 
        });

        const r2Key = `users/${emailFolder}/${formName}/rec_${Date.now()}.mp4`;
        const longUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;

        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key, Body: fs.createReadStream(compressedPath), ContentType: "video/mp4" }));
        await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: r2Key.replace('.mp4', '.txt'), Body: transcription.text, ContentType: "text/plain; charset=utf-8" }));

        const shortId = generateShortId();
        const serverUrl = `${req.protocol}://${req.get('host')}`;
        const secureViewUrl = `${serverUrl}/v/${shortId}`; 

        await db.collection('shortLinks').doc(shortId).set({
            url: longUrl,
            r2Key: r2Key,
            type: 'video',
            email: ownerEmail,
            transcription: transcription.text,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        res.json({ publicUrl: secureViewUrl, transcription: transcription.text });

    } catch (e) { 
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
        res.status(500).json({ error: e.message }); 
    }
});

// 🔥 8. ADMIN: CREATE CLIENT
app.post('/api/create-client', verifyToken, async (req, res) => {
    try {
        const ADMIN_EMAIL = "simonenkoyaroslav2008@gmail.com"; // <--- ⚠️ ВСТАВ СЮДИ СВІЙ EMAIL!
        
        if (req.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
            return res.status(403).json({ error: "Ви не адмін!" });
        }

        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email required" });

        const password = generatePassword(10);

        await admin.auth().createUser({ email: email, password: password, emailVerified: true });

        res.json({
            success: true,
            email: email,
            password: password,
            link: "https://vdfy.org/install"
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

// OTHER CLIENT APIS
app.get('/api/my-videos', verifyToken, async (req, res) => {
    const email = req.user.email ? req.user.email.toLowerCase() : null;
    if (!email) return res.json({ videos: [] });
    try {
        const data = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, Prefix: `users/${email.replace(/[@.]/g, '_')}/` }));
        const videos = (data.Contents || []).filter(i => i.Key.endsWith('.mp4') || i.Key.endsWith('.webm')).map(i => ({
            key: i.Key, url: `${process.env.R2_PUBLIC_URL}/${i.Key}`, uploadedAt: i.LastModified,
            formName: i.Key.split('/').length > 3 ? decodeURIComponent(i.Key.split('/')[2]) : "General"
        }));
        res.json({ videos: videos.sort((a,b) => b.uploadedAt - a.uploadedAt) });
    } catch (e) { res.json({ videos: [] }); }
});

app.delete('/api/delete-video', verifyToken, async (req, res) => {
    try {
        const email = req.user.email.toLowerCase();
        const videoKey = req.body.videoKey;
        if (!videoKey.startsWith(`users/${email.replace(/[@.]/g, '_')}/`)) return res.status(403).json({ error: "Denied" });
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey }));
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: videoKey.replace(/\.(mp4|webm)$/, '.txt') })).catch(()=>{});
        const snapshot = await db.collection('shortLinks').where('r2Key', '==', videoKey).get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze-text', verifyToken, async (req, res) => {
    try {
        const textRes = await fetch(req.body.textUrl);
        const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini", messages: [{ role: "system", content: "Summarize." }, { role: "user", content: await textRes.text() }]
        });
        res.json({ analysis: gpt.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AI Error" }); }
});