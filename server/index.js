import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const app=express();
const PORT=Number(process.env.PORT||8787);
const FFMPEG=process.env.FFMPEG_PATH||'ffmpeg';
const YTDLP=process.env.YTDLP_PATH||'yt-dlp';
const EDGETTS=process.env.EDGE_TTS_PATH||'edge-tts';
const ROOT=process.env.WORK_DIR||path.resolve('server-data');
const DIST=path.resolve('dist');
await fs.mkdir(ROOT,{recursive:true});
await fs.mkdir(path.join(ROOT,'uploads'),{recursive:true});
app.use(cors());
app.use(express.json({limit:'2mb'}));
app.use('/files',express.static(ROOT));

const upload=multer({dest:path.join(ROOT,'uploads'),limits:{fileSize:500*1024*1024}});
const jobs=new Map();
const langCodes={Gujarati:'gu',Hindi:'hi',Marathi:'mr',English:'en',Bengali:'bn',Tamil:'ta',Telugu:'te',Kannada:'kn',Malayalam:'ml',Punjabi:'pa'};
const voices={
  Gujarati:'gu-IN-DhwaniNeural',Hindi:'hi-IN-SwaraNeural',Marathi:'mr-IN-AarohiNeural',
  English:'en-IN-NeerjaNeural',Bengali:'bn-IN-TanishaaNeural',Tamil:'ta-IN-PallaviNeural',
  Telugu:'te-IN-ShrutiNeural',Kannada:'kn-IN-SapnaNeural',Malayalam:'ml-IN-SobhanaNeural',Punjabi:'pa-IN-VaaniNeural'
};

function run(cmd,args,cwd=ROOT){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});
    let out='',err='';
    p.stdout.on('data',d=>out+=d);
    p.stderr.on('data',d=>err+=d);
    p.on('error',e=>reject(e));
    p.on('close',code=>code===0?resolve(out):reject(new Error(`${cmd} failed (${code}): ${err.slice(-3000)}`)));
  });
}
function normalizeYouTubeUrl(value){let url=String(value||'').trim();if(!/^https?:\/\//i.test(url))url=`https://${url}`;return url;}
function validYouTubeUrl(value){try{const u=new URL(normalizeYouTubeUrl(value));return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)}catch{return false}}
function setJob(id,patch){const old=jobs.get(id)||{id};jobs.set(id,{...old,...patch})}

function cleanVtt(vtt){
  const blocks=vtt.replace(/^WEBVTT[^\n]*\n/i,'').split(/\n\s*\n/);
  const lines=[];let last='';
  for(const block of blocks){
    const raw=block.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    const text=raw.filter(x=>!/^\d+$/.test(x)&&!/^\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->/.test(x)&&!/^NOTE\b/i.test(x)).join(' ')
      .replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
    if(text&&text!==last){lines.push(text);last=text;}
  }
  return lines.join(' ');
}

async function getTranscriptFromCaptions(dir,url){
  const subDir=path.join(dir,'captions');
  await fs.mkdir(subDir,{recursive:true});
  try{await run(YTDLP,['--no-playlist','--no-warnings','--write-auto-subs','--write-subs','--sub-langs','all','--sub-format','vtt','--skip-download','-o',path.join(subDir,'source'),url]);}catch(e){
    const files=await fs.readdir(subDir).catch(()=>[]);
    if(!files.some(f=>f.endsWith('.vtt')))throw e;
  }
  const files=(await fs.readdir(subDir)).filter(f=>f.toLowerCase().endsWith('.vtt'));
  if(!files.length)throw new Error('No captions were found for this video. Try a YouTube video with subtitles/captions enabled.');
  const preferred=files.find(f=>/\.en(?:[-_][A-Za-z0-9]+)?\.vtt$/i.test(f))||files[0];
  const text=cleanVtt(await fs.readFile(path.join(subDir,preferred),'utf8'));
  if(!text)throw new Error('The video captions were empty.');
  return text;
}

function splitText(text,max=3500){
  const out=[];let rest=text.trim();
  while(rest.length>max){
    let cut=Math.max(rest.lastIndexOf('. ',max),rest.lastIndexOf('? ',max),rest.lastIndexOf('! ',max),rest.lastIndexOf(' ',max));
    if(cut<500)cut=max;
    out.push(rest.slice(0,cut).trim());rest=rest.slice(cut).trim();
  }
  if(rest)out.push(rest);return out;
}

async function translateChunk(text,target){
  const endpoint=new URL('https://translate.googleapis.com/translate_a/single');
  endpoint.searchParams.set('client','gtx');endpoint.searchParams.set('sl','auto');endpoint.searchParams.set('tl',target);endpoint.searchParams.set('dt','t');endpoint.searchParams.set('q',text);
  const r=await fetch(endpoint);
  if(!r.ok)throw new Error(`Translation service returned ${r.status}.`);
  const data=await r.json();
  const translated=Array.isArray(data?.[0])?data[0].map(x=>x?.[0]||'').join(''):'';
  if(!translated.trim())throw new Error('Translation returned empty text.');
  return translated.trim();
}
async function translate(text,target){
  const parts=splitText(text,3500),out=[];
  for(let i=0;i<parts.length;i++){out.push(await translateChunk(parts[i],target));}
  return out.join(' ');
}

async function tts(text,language,outPath,dir){
  const voice=voices[language];
  if(!voice)throw new Error(`No voice configured for ${language}.`);
  const parts=splitText(text,2800),files=[];
  for(let i=0;i<parts.length;i++){
    const txt=path.join(dir,`tts-${i}.txt`),mp3=path.join(dir,`tts-${i}.mp3`);
    await fs.writeFile(txt,parts[i],'utf8');
    await run(EDGETTS,['--voice',voice,'--file',txt,'--write-media',mp3]);
    files.push(mp3);
  }
  if(files.length===1){await fs.copyFile(files[0],outPath);return;}
  const list=path.join(dir,'tts-list.txt');
  await fs.writeFile(list,files.map(f=>`file '${f.replaceAll("'","'\\''")}'`).join('\n'),'utf8');
  await run(FFMPEG,['-y','-f','concat','-safe','0','-i',list,'-c','copy',outPath]);
}

async function processJob(job){
  const dir=path.join(ROOT,job.id);await fs.mkdir(dir,{recursive:true});
  try{
    setJob(job.id,{status:'downloading',progress:10});
    const input=path.join(dir,'source.mp4');
    if(job.url)await run(YTDLP,['--no-playlist','--no-warnings','--merge-output-format','mp4','-o',input,job.url]);
    else await fs.copyFile(job.uploadPath,input);
    setJob(job.id,{status:'reading captions',progress:35});
    const transcript=job.url?await getTranscriptFromCaptions(dir,job.url):null;
    if(!transcript)throw new Error('For keyless mode, the video must have captions. Use a YouTube video with subtitles enabled.');
    setJob(job.id,{status:'translating',progress:55});
    const translated=await translate(transcript,langCodes[job.language]);
    setJob(job.id,{status:'generating voice',progress:72});
    const dubbed=path.join(dir,'dub.mp3');await tts(translated,job.language,dubbed,dir);
    setJob(job.id,{status:'rendering video',progress:88});
    const output=path.join(dir,'translated.mp4');
    await run(FFMPEG,['-y','-i',input,'-i',dubbed,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-shortest',output]);
    setJob(job.id,{status:'ready',progress:100,videoUrl:`/files/${job.id}/translated.mp4`});
  }catch(e){setJob(job.id,{status:'error',progress:0,error:e?.message||'Dubbing failed.'});}
  finally{if(job.uploadPath)try{await fs.unlink(job.uploadPath)}catch{}}
}

app.get('/api/health',(req,res)=>res.json({ok:true,mode:'keyless',translation:'Google Translate web endpoint',tts:'Edge TTS',ffmpeg:FFMPEG,ytDlp:YTDLP}));
app.post('/api/dub',async(req,res)=>{
  try{
    const {url,targetLanguage,language}=req.body||{},lang=targetLanguage||language,normalized=normalizeYouTubeUrl(url);
    if(!validYouTubeUrl(normalized))return res.status(400).json({error:'Enter a valid YouTube URL.'});
    if(!langCodes[lang])return res.status(400).json({error:'Unsupported target language.'});
    const id=crypto.randomUUID(),job={id,url:normalized,language:lang,status:'queued',progress:0};jobs.set(id,job);
    processJob(job).catch(e=>setJob(id,{status:'error',progress:0,error:e?.message||'Dubbing failed.'}));
    res.status(202).json({jobId:id,status:'queued'});
  }catch(e){res.status(500).json({error:e?.message||'Could not start dubbing.'})}
});
app.post('/api/dub/upload',upload.single('video'),async(req,res)=>{
  try{
    const lang=req.body?.targetLanguage;
    if(!req.file||!langCodes[lang]){if(req.file)try{await fs.unlink(req.file.path)}catch{};return res.status(400).json({error:'Video and supported target language are required.'});}
    const id=crypto.randomUUID(),job={id,uploadPath:req.file.path,language:lang,status:'queued',progress:0};jobs.set(id,job);
    processJob(job).catch(e=>setJob(id,{status:'error',progress:0,error:e?.message||'Dubbing failed.'}));
    res.status(202).json({jobId:id,status:'queued'});
  }catch(e){res.status(500).json({error:e?.message||'Could not start dubbing.'})}
});
app.get('/api/dub/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found'});const {uploadPath,...safe}=j;res.json(safe);});
app.use(express.static(DIST));
app.use((req,res,next)=>{if(req.method!=='GET'||req.path.startsWith('/api/')||req.path.startsWith('/files/'))return next();res.sendFile(path.join(DIST,'index.html'));});
app.listen(PORT,()=>console.log(`LinguaDub keyless server listening on port ${PORT}`));
