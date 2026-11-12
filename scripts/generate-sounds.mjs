// Generates the simulator's sound effects with the ElevenLabs sound-effects API
// and writes them to public/audio/ together with manifest.json, which the audio
// engine (src/audio/sound.ts) reads at run time.
//
//   npm run generate-sounds                 generate whatever is missing
//   npm run generate-sounds -- --force      regenerate everything
//   npm run generate-sounds -- --only=siren,thunder_near
//   npm run generate-sounds -- --dry        list what would be generated
//
// The key is read from ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) in .env. It is
// only ever sent to api.elevenlabs.io and never reaches the browser bundle.
//
// Models: one-shots use eleven_text_to_sound_v3 (the newest sound-effects model);
// loops use eleven_text_to_sound_v2 because it is the only one that supports
// seamless looping. ("Eleven v4" is a speech model, not a sound-effects one.)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'audio');
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128';
const LOOP_MODEL = 'eleven_text_to_sound_v2';
const SHOT_MODEL = 'eleven_text_to_sound_v3';
const NO_EXTRAS = 'No music, no voices.';

/** group → clips. Loops are single clips; one-shots have variants the engine picks from at random. */
const SOUNDS = [
  { group: 'roar_far', loop: true, seconds: 28, prompts: [
    'A large tornado heard from a mile away: deep, continuous low-frequency rumble like an endless freight train mixed with a huge waterfall. Steady and ominous.',
  ] },
  { group: 'roar_near', loop: true, seconds: 28, prompts: [
    'Standing next to a violent tornado: deafening continuous roar of extreme wind, like a jet engine and a freight train passing at arm\'s length, heavy sub-bass rumble with a howling shriek on top. Constant intensity.',
  ] },
  { group: 'wind', loop: true, seconds: 24, prompts: [
    'Strong storm wind gusting and howling down an open suburban street, whistling through power lines and thrashing tree branches. Continuous, no rain.',
  ] },
  { group: 'rain', loop: true, seconds: 22, prompts: [
    'Heavy rain pouring on asphalt and rooftops with a few small hailstones, steady close downpour. No thunder.',
  ] },
  { group: 'debris', loop: true, seconds: 24, prompts: [
    'Continuous chaos of debris inside a tornado: wooden boards splintering, sheet metal clanging and scraping, glass shattering, heavy objects crashing and tumbling. Dense and violent.',
  ] },
  { group: 'siren', loop: true, seconds: 28, prompts: [
    'Outdoor tornado warning siren wailing steadily in the distance across a quiet town, slow rotating civil-defense siren with a slight echo.',
  ] },
  { group: 'siren_police', loop: true, seconds: 14, prompts: [
    'Police car siren, fast urgent yelp and wail, heard close on a city street. Continuous.',
  ] },
  { group: 'siren_ambulance', loop: true, seconds: 14, prompts: [
    'Ambulance siren, two-tone hi-lo emergency siren, heard close on a city street. Continuous.',
  ] },
  { group: 'siren_fire', loop: true, seconds: 16, prompts: [
    'Fire engine siren: deep mechanical rising and falling wail with blasts of a loud air horn, heard close on a city street. Continuous.',
  ] },
  { group: 'horn', seconds: 2, prompts: [
    'A car horn held down urgently, one long angry blast.',
    'Two quick urgent car horn honks.',
    'A truck air horn, one loud blast.',
  ] },
  { group: 'thunder_near', seconds: 8, prompts: [
    'A very close lightning strike: sharp explosive crack, then a long deep rolling thunder rumble that fades away.',
    'Loud thunderclap directly overhead with a heavy booming roll and crackle, fading out.',
    'Close thunder: a tearing crack and a powerful low rumbling boom decaying over several seconds.',
  ] },
  { group: 'thunder_far', seconds: 9, prompts: [
    'Distant thunder: a low, soft rolling rumble far away, slowly fading.',
    'Faraway thunder grumbling along the horizon, deep and muffled.',
  ] },
  { group: 'collapse', seconds: 5, prompts: [
    'A wooden house torn apart by extreme wind: timber frame cracking and snapping, then walls collapsing with a heavy crash of boards and debris.',
    'The roof ripped off a house: wrenching nails and wood, splintering rafters, then a crash.',
    'A building collapsing: heavy crash of bricks, lumber and drywall falling into a pile, dusty rumble.',
  ] },
  { group: 'glass', seconds: 2.5, prompts: [
    'A large window shattering violently, shards raining onto concrete.',
    'Several glass panes smashing in quick succession and tinkling to the ground.',
  ] },
  { group: 'metal', seconds: 4, prompts: [
    'Sheet-metal roof panels ripped off by wind: loud screeching, bending and clanging steel.',
    'A large corrugated metal sheet tumbling and slamming onto pavement, harsh clang and rattle.',
  ] },
  { group: 'vehicle', seconds: 4, prompts: [
    'A car thrown through the air slams into the ground and tumbles: heavy crunch of metal and breaking glass.',
    'Heavy vehicle crash: massive metallic impact, crumpling steel, glass breaking, debris settling.',
  ] },
  { group: 'transformer', seconds: 3, prompts: [
    'An electrical transformer exploding on a power pole: loud electric zap, crackling arc and a sharp bang with buzzing.',
    'Power-line arc flash: intense buzzing electrical crackle, a loud pop and sizzling sparks.',
  ] },
  { group: 'tree', seconds: 4, prompts: [
    'A large tree trunk cracking and snapping in high wind, then crashing down through its branches.',
    'A thick wooden trunk splintering with loud cracks, followed by a heavy thud and rustling leaves.',
  ] },
  { group: 'alarm', seconds: 6, prompts: [
    'A car alarm blaring with honking horn and siren chirps, heard from across a street.',
  ] },
];

// ---------------------------------------------------------------- arguments and key
const args = process.argv.slice(2);
const force = args.includes('--force');
const dry = args.includes('--dry');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);

function readEnv() {
  const env = { ...process.env };
  const file = join(ROOT, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return env;
}
const env = readEnv();
const KEY = env.ELEVEN_LABS_API_KEY || env.ELEVENLABS_API_KEY || env.XI_API_KEY;

const fileOf = (group, i) => `${group}_${i + 1}.mp3`;

function writeManifest() {
  const have = new Set(existsSync(OUT) ? readdirSync(OUT) : []);
  const groups = {};
  for (const s of SOUNDS) {
    const files = s.prompts.map((_, i) => fileOf(s.group, i)).filter((f) => have.has(f));
    if (files.length) groups[s.group] = files;
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ source: 'ElevenLabs sound effects', loopModel: LOOP_MODEL, oneShotModel: SHOT_MODEL, groups }, null, 2) + '\n');
  return groups;
}

async function generate(text, seconds, loop, model) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${text} ${NO_EXTRAS}`, duration_seconds: seconds, prompt_influence: 0.45, loop, model_id: model }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const body = await res.text();
    let detail = body;
    try { const d = JSON.parse(body).detail; detail = typeof d === 'string' ? d : d?.message ?? body; } catch { /* plain text */ }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    const err = new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
    err.status = res.status;
    // a rejected key or an exhausted quota will fail every other clip too
    err.fatal = [401, 402, 403].includes(res.status) || /api[ _]key|quota|credit|unauthori[sz]ed/i.test(body);
    throw err;
  }
}

// ---------------------------------------------------------------- run
mkdirSync(OUT, { recursive: true });
const jobs = [];
for (const s of SOUNDS) {
  if (only && !only.includes(s.group)) continue;
  s.prompts.forEach((text, i) => {
    const file = fileOf(s.group, i);
    if (force || !existsSync(join(OUT, file))) jobs.push({ ...s, text, file });
  });
}
const total = jobs.reduce((t, j) => t + j.seconds, 0);
console.log(`${jobs.length} clip(s) to generate, ${total.toFixed(0)} s of audio in all.`);
if (dry || jobs.length === 0) {
  for (const j of jobs) console.log(`  ${j.file}  ${j.seconds}s  ${j.loop ? 'loop' : 'one-shot'}`);
  writeManifest();
  process.exit(0);
}
if (!KEY) {
  console.error('No API key: put ELEVEN_LABS_API_KEY=sk_... in .env (ElevenLabs → Developers → API keys).');
  process.exit(1);
}
if (!KEY.startsWith('sk_')) {
  console.warn('Warning: the key in .env does not start with "sk_". ElevenLabs API keys do; a key *ID* will be rejected.');
}

let done = 0, failed = 0, fatal = null;
let shotModel = SHOT_MODEL;
async function worker() {
  for (;;) {
    const job = jobs.shift();
    if (!job || fatal) return;
    try {
      let audio;
      try {
        audio = await generate(job.text, job.seconds, Boolean(job.loop), job.loop ? LOOP_MODEL : shotModel);
      } catch (err) {
        // an account without the newest model still gets its one-shots, from v2
        if (job.loop || shotModel === LOOP_MODEL || err.fatal) throw err;
        console.warn(`  ${SHOT_MODEL} unavailable (${err.message}); using ${LOOP_MODEL} for one-shots.`);
        shotModel = LOOP_MODEL;
        audio = await generate(job.text, job.seconds, false, LOOP_MODEL);
      }
      writeFileSync(join(OUT, job.file), audio);
      done++;
      console.log(`  ✓ ${job.file}  (${(audio.length / 1024).toFixed(0)} kB)`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${job.file}: ${err.message}`);
      if (err.fatal) fatal = err;
    }
  }
}
await Promise.all([worker(), worker()]);
const groups = writeManifest();
console.log(`${done} generated, ${failed} failed. Manifest lists ${Object.values(groups).flat().length} clip(s) in ${Object.keys(groups).length} group(s).`);
if (fatal) {
  console.error('Stopped early: ElevenLabs refused the key or the account is out of credits.');
  process.exit(1);
}
process.exit(failed ? 1 : 0);
