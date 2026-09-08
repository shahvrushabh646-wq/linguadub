import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();
const app=express(),PORT=Number(process.env.PORT||8787),FFMPEG=process.env.FFMPEG_PATH||ffmpegPath||'ffmpeg',YTDLP=process.env.YTDLP_PATH||'yt-dlp',ROOT=process.env.WORK_DIR||path.resolve('server-data'),DIST=path.resolve('dist');
await fs.mkdir(ROOT,{recursive:true});await fs.mkdir(path.join(ROOT,'uploads'),{recursive:true});
app.use(cors());app.use(express.json({limit:'2mb'}));app.use('/files',express.static(ROOT));
const upload=multer({dest:path.join(ROOT,'uploads'),limits:{fileSize:500*1024*1024}}),jobs=new Map();
const langCodes={Gujarati:'gu',Hindi:'hi',Marathi:'mr',English:'en',Bengali:'bn',Tamil:'ta',Telugu:'te',Kannada:'kn',Malayalam:'ml',Punjabi:'pa'};
const openai=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
function run(cmd,args,cwd=ROOT){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>code===0?resolve(out):reject(new Error(`${cmd} failed (${code}): ${err.slice(-3000)}`)))})}
async function translate(text,target){if(!openai)throw new Error('OPENAI_API_KEY is not configured');const model=process.env.OPENAI_TEXT_MODEL||'gpt-5.6-luna';const r=await openai.responses.create({model,input:`Translate the following spoken-video transcript into ${target}. Preserve meaning, names and numbers. Return only the translated spoken script, with no commentary.\n\n${text}`});return r.output_text.trim()}
async function transcribe(audioPath){if(!openai)throw new Error('OPENAI_API_KEY is not configured');const model=process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-transcribe';const r=await openai.audio.transcriptions.create({file:createReadStream(audioPath),model});return r.text}
async function tts(text,language,outPath){if(!openai)throw new Error('OPENAI_API_KEY is not configured');const model=process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts',voice=process.env.OPENAI_TTS_VOICE||'alloy';const speech=await openai.audio.speech.create({model,voice,input:text,response_format:'mp3',instructions:`Speak naturally in ${language}. Clear dubbing voice, moderate pace.`});await fs.writeFile(outPath,Buffer.from(await speech.arrayBuffer()))}
async function processJob(job){const dir=path.join(ROOT,job.id);await fs.mkdir(dir,{recursive:true});try{jobs.set(job.id,{...job,status:'downloading',progress:10});const input=path.join(dir,'source.mp4');if(job.url)await run(YTDLP,['--no-playlist','--no-warnings','--merge-output-format','mp4','-o',input,job.url]);else await fs.copyFile(job.uploadPath,input);jobs.set(job.id,{...job,status:'extracting audio',progress:25});const audio=path.join(dir,'source.mp3');await run(FFMPEG,['-y','-i',input,'-vn','-ac','1','-ar','16000','-b:a','64k',audio]);jobs.set(job.id,{...job,status:'transcribing',progress:40});const transcript=await transcribe(audio);jobs.set(job.id,{...job,status:'translating',progress:55});const translated=await translate(transcript,job.language);jobs.set(job.id,{...job,status:'generating voice',progress:72});const dubbed=path.join(dir,'dub.mp3');await tts(translated,job.language,dubbed);jobs.set(job.id,{...job,status:'rendering video',progress:88});const output=path.join(dir,'translated.mp4');await run(FFMPEG,['-y','-i',input,'-i',dubbed,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-shortest',output]);jobs.set(job.id,{...job,status:'ready',progress:100,videoUrl:`/files/${job.id}/translated.mp4`})}catch(e){jobs.set(job.id,{...job,status:'error',progress:0,error:e.message})}finally{if(job.uploadPath)try{await fs.unlink(job.uploadPath)}catch{}}}
app.get('/api/health',(req,res)=>res.json({ok:true,openaiConfigured:Boolean(openai),ffmpeg:FFMPEG,ytDlp:YTDLP}));
app.post('/api/dub',async(req,res)=>{const {url,targetLanguage,language}=req.body||{},lang=targetLanguage||language;if(!url||!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url))return res.status(400).json({error:'Enter a valid YouTube URL.'});if(!langCodes[lang])return res.status(400).json({error:'Unsupported target language.'});const id=crypto.randomUUID(),job={id,url,language:lang,status:'queued',progress:0};jobs.set(id,job);processJob(job);res.status(202).json({jobId:id})});
app.post('/api/dub/upload',upload.single('video'),async(req,res)=>{const lang=req.body?.targetLanguage;if(!req.file||!langCodes[lang])return res.status(400).json({error:'Video and supported target language are required.'});const id=crypto.randomUUID(),job={id,uploadPath:req.file.path,language:lang,status:'queued',progress:0};jobs.set(id,job);processJob(job);res.status(202).json({jobId:id})});
app.get('/api/dub/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'Job not found'});const {uploadPath,...safe}=j;res.json(safe)});
app.use(express.static(DIST));
app.use((req,res,next)=>{if(req.method!=='GET'||req.path.startsWith('/api/')||req.path.startsWith('/files/'))return next();res.sendFile(path.join(DIST,'index.html'))});
app.listen(PORT,()=>console.log(`LinguaDub listening on port ${PORT}`));
