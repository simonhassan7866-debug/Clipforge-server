require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const OUTPUT_DIR = path.join(__dirname, 'outputs');
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

app.use('/videos', express.static(OUTPUT_DIR));

const jobs = {};

app.post('/api/video-info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    const info = await ytdl.getBasicInfo(url);
    const details = info.videoDetails;
    res.json({
      videoId: details.videoId,
      title: details.title,
      author: details.author.name,
      durationSeconds: Number(details.lengthSeconds),
      thumbnail: details.thumbnails[details.thumbnails.length - 1]?.url
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate-shorts', async (req, res) => {
  const { url, numShorts = 5, clipLength = 30, settings = {} } = req.body;
  if (!ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'downloading',
    progress: 5,
    clips: [],
    error: null
  };

  res.json({ jobId });

  processVideoInBackground(jobId, url, Number(numShorts), Number(clipLength), settings);
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

async function processVideoInBackground(jobId, url, numShorts, clipLength, settings) {
  const sourcePath = path.join(TEMP_DIR, `${jobId}_source.mp4`);

  try {
    const info = await ytdl.getInfo(url);
    const totalDuration = Number(info.videoDetails.lengthSeconds);
    const videoTitle = info.videoDetails.title.replace(/[^\w\s-]/gi, '').slice(0, 40);

    await new Promise((resolve, reject) => {
      const stream = ytdl(url, { quality: 'highest', filter: 'audioandvideo' });
      const writeStream = fs.createWriteStream(sourcePath);
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    jobs[jobId].status = 'cutting';
    jobs[jobId].progress = 30;

    const maxStart = Math.max(0, totalDuration - clipLength);
    const step = numShorts > 1 ? Math.floor(maxStart / numShorts) : 0;

    for (let i = 0; i < numShorts; i++) {
      const startTime = Math.min(i * step, maxStart);
      const outFileName = `${jobId}_short_${i + 1}.mp4`;
      const outPath = path.join(OUTPUT_DIR, outFileName);

      await new Promise((resolve, reject) => {
        ffmpeg(sourcePath)
          .setStartTime(startTime)
          .setDuration(clipLength)
          .videoFilters([
            'crop=ih*9/16:ih',
            'scale=1080:1920'
          ])
          .outputOptions(['-c:v libx264', '-preset fast', '-crf 23', '-c:a aac'])
          .output(outPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      jobs[jobId].clips.push({
        clipNumber: i + 1,
        title: `${videoTitle} - Part ${i + 1}`,
        duration: `${clipLength}s`,
        startTime,
        downloadUrl: `http://localhost:5000/videos/${outFileName}`,
        status: 'completed'
      });

      jobs[jobId].progress = 30 + Math.round(((i + 1) / numShorts) * 70);
    }

    jobs[jobId].status = 'completed';
    jobs[jobId].progress = 100;

    if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);

  } catch (error) {
    console.error('Processing Error:', error);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = error.message;
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  
