import { normalize, parseScript } from "./follower.js";
import { hasRecent, hasUnsaved, loadRecent, makeRecorder, markSaved } from "./recorder.js";

const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"),node => [node.id,node]));
const {
  editorScreen, cameraScreen, reviewScreen, openForm, script, scriptCount, editorNotice,
  importButton, importInput, openCamera, lastVideo, cameraVideo, closeCamera, followState,
  counter, reader, readStack, readCue, previousCue, nextCue, laterCue, dragCue, cameraNote,
  first, earlier, later, followToggle, smaller, larger, record, recordText,
  resultVideo, resultNotice, downloadVideo, shareVideo, doneReview
} = elements;

const scriptKey = "genzheshuo-script";
const configKey = "genzheshuo-reader";
const defaults = { font:29, anchor:.4, index:0 };
let config = defaults;
try {
  config = { ...defaults, ...JSON.parse(localStorage.getItem(configKey) ?? "{}") };
  script.value = localStorage.getItem(scriptKey) ?? "";
} catch { /* additional browser storage may be disabled */ }

const clamp = (val,min,max) => Math.max(min,Math.min(max,val));
const persist = () => { try { localStorage.setItem(configKey,JSON.stringify(config)); } catch {} };
let cues = [];
let current = 0;
let character = 0;
let scene = 0;
let stream;
let context;
let input;
let node;
let voice;
let voiceSession = 0;
let queuedAudio = 0;
let restartStream = false;
let mode = "loading";
let following = true;
let capture;
let captureMode = "idle";
let clock;
let awake;
let clip;
let clipURL;
let layoutFrame;

function screen(active) {
  for (const view of [editorScreen,cameraScreen,reviewScreen]) view.hidden = view !== active;
  if (active !== cameraScreen) window.scrollTo(0,0);
}

function setNotice(message) { editorNotice.textContent = message; }
function setMode(value,status) {
  mode = value;
  followState.textContent = status;
  followToggle.textContent = value === "error" ? "重试跟读" : following ? "暂停跟读" : "开启跟读";
  followToggle.disabled = !stream || value === "loading";
  renderRecord();
}

function renderRecord() {
  record.disabled = !stream || captureMode === "preparing" || captureMode === "saving" ||
    (captureMode === "idle" && mode === "loading");
  const saving = captureMode === "saving";
  const recording = captureMode === "recording";
  const caption = saving ? "正在保存…" : captureMode === "preparing" ? "准备录制…" :
    recording ? "结束录制" : "开始录制";
  record.classList.toggle("on",recording || saving);
  record.setAttribute("aria-label",caption);
  recordText.textContent = caption;
}

function layoutReader() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    if (cameraScreen.hidden || !readCue.firstChild) return;
    const length = readCue.firstChild.length;
    const chosen = clamp(character - 1,0,length - 1);
    const range = document.createRange();
    range.setStart(readCue.firstChild,chosen);
    range.setEnd(readCue.firstChild,chosen + 1);
    const cueBox = readCue.getBoundingClientRect();
    const word = range.getBoundingClientRect();
    const lineCenter = word.height ? word.top - cueBox.top + word.height / 2 : cueBox.height / 2;
    const height = reader.clientHeight;
    const anchor = clamp(config.anchor * height,90,Math.max(90,height - 160));
    const shift = anchor - readCue.offsetTop - lineCenter;
    readStack.style.setProperty("--scroll",Math.round(shift) + "px");
    dragCue.style.setProperty("--anchor",anchor + "px");
  });
}

function updatePosition(index,char = 0,force = false) {
  const next = clamp(index,0,Math.max(0,cues.length - 1));
  if (!force && current === next && character === char) return;
  if (force || next !== current) {
    previousCue.textContent = cues[next - 1] ?? "";
    readCue.textContent = cues[next] ?? "";
    nextCue.textContent = cues[next + 1] ?? "";
    laterCue.textContent = cues[next + 2] ?? "";
    first.disabled = earlier.disabled = next === 0;
    later.disabled = next === cues.length - 1;
  }
  current = next;
  character = char;
  if (config.index !== current) { config.index = current; persist(); }
  layoutReader();
}

function resyncAt(index) {
  if (voice && mode === "ready") {
    // A new session ignores text already queued for the old reading position.
    voice.postMessage({type:"prepare",session:++voiceSession,index,cues});
    queuedAudio = 0;
    restartStream = false;
  }
}

function manually(direction) {
  updatePosition(current + direction);
  resyncAt(current);
}

function setFont(delta) {
  config.font = clamp(config.font + delta,19,49);
  reader.style.setProperty("--font",config.font + "px");
  persist();
  layoutReader();
}

function voiceError(message) {
  following = false;
  cameraNote.textContent = message + "。可以手动翻句。";
  setMode("error","跟读暂不可用");
}

async function beginVoice(token) {
  try {
    if (!context || token !== scene) return;
    following = true;
    cameraNote.textContent = "";
    setMode("loading","正在准备语音…");
    if (!voice) {
      voice = new Worker(new URL("./voice-worker.js",import.meta.url),{type:"module"});
      voice.onerror = () => {
        voice?.terminate();
        voice = undefined;
        if (token === scene) voiceError("语音组件未能启动");
      };
      voice.onmessage = ({data}) => {
        if (scene !== token || data.session !== voiceSession) return;
        if (data.type === "loading") {
          followState.textContent = "载入语音模型 " + data.loaded + "/" + data.total;
        }
        if (data.type === "ready") {
          setMode("ready",following ? "语音跟读中" : "跟读已暂停");
        }
        if (data.type === "position" && following) updatePosition(data.index,data.character);
        if (data.type === "processed") queuedAudio = Math.max(0,queuedAudio - 1);
        if (data.type === "error") {
          voice?.terminate();
          voice = undefined;
          voiceError(data.message);
        }
      };
    }
    if (!node) {
      await context.resume();
      await context.audioWorklet.addModule("./microphone.js");
      if (token !== scene || !stream) return;
      input = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context,"prompt-microphone", {numberOfInputs:1,numberOfOutputs:1,
        outputChannelCount:[1],channelCount:1,channelCountMode:"explicit"});
      node.port.onmessage = ({data}) => {
        if (!following || mode !== "ready" || !voice || token !== scene) return;
        if (queuedAudio >= 20) { restartStream = true; return; }
        if (restartStream) {
          if (queuedAudio) return;
          resyncAt(current);
        }
        queuedAudio++;
        voice.postMessage({type:"samples",session:voiceSession,samples:data},[data.buffer]);
      };
      input.connect(node);
      node.connect(context.destination);
    }
    queuedAudio = 0;
    restartStream = false;
    voice.postMessage({type:"prepare",session:++voiceSession,index:current,cues});
  } catch (error) {
    if (token === scene) voiceError("无法开启麦克风跟读");
  }
}

function dropCamera() {
  scene++;
  stream?.getTracks().forEach(track => track.stop());
  stream = undefined;
  cameraVideo.srcObject = null;
  input?.disconnect();
  node?.disconnect();
  node?.port.close();
  input = node = undefined;
  context?.close().catch(() => {});
  context = undefined;
  voice?.terminate();
  voice = undefined;
  awake?.release().catch(() => {});
  awake = undefined;
  queuedAudio = 0;
  clearInterval(clock);
  counter.hidden = true;
}

function cameraFailure(error) {
  const descriptions = {
    NotAllowedError:"请在 Safari 允许这个网页使用相机和麦克风，再打开一次。",
    NotFoundError:"没有找到可用的相机或麦克风。",
    NotReadableError:"相机或麦克风正在被占用。关闭其他拍摄应用后重试。"
  };
  const message = descriptions[error.name] ?? "相机未能打开，请重新打开页面再试。";
  dropCamera();
  screen(editorScreen);
  setNotice(message);
}

async function showCamera(event) {
  event.preventDefault();
  if (openCamera.disabled) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setNotice("请用 iPhone 的 Safari 打开这个 HTTPS 地址，并允许相机和麦克风。");
    return;
  }
  cues = parseScript(script.value);
  if (!cues.some(cue => normalize(cue).speech)) {
    setNotice("请先粘贴或者导入话术。");
    script.focus();
    return;
  }
  openCamera.disabled = true;
  const token = ++scene;
  screen(cameraScreen);
  cameraNote.textContent = "";
  setMode("loading","正在打开相机…");
  updatePosition(config.index,0,true);
  setFont(0);
  try {
    const audioClass = window.AudioContext || window.webkitAudioContext;
    if (audioClass) {
      context = new audioClass();
      context.resume().catch(() => {});
    }
    const captureStream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:"user"}, width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30,max:30} },
      audio:{ channelCount:1, echoCancellation:false }
    });
    if (token !== scene) {
      captureStream.getTracks().forEach(track => track.stop());
      return;
    }
    stream = captureStream;
    cameraVideo.srcObject = stream;
    cameraVideo.play().catch(() => {});
    navigator.wakeLock?.request("screen").then(lock => {
      if (token === scene) awake = lock;
      else lock.release().catch(() => {});
    }).catch(() => {});
    for (const track of stream.getTracks()) {
      track.addEventListener("ended",() => {
        if (token !== scene) return;
        if (captureMode === "recording") finishRecording();
        else if (captureMode === "idle") cameraFailure(new Error("Camera closed"));
      });
    }
    if (!context?.audioWorklet || typeof WebAssembly !== "object") {
      voiceError("当前 Safari 版本暂不支持离线跟读");
    } else beginVoice(token);
  } catch (error) {
    if (token === scene) cameraFailure(error);
  } finally { openCamera.disabled = false; }
}

function showClip(item) {
  clip = item;
  if (clipURL) URL.revokeObjectURL(clipURL);
  clipURL = URL.createObjectURL(item.file);
  resultVideo.src = clipURL;
  downloadVideo.href = clipURL;
  downloadVideo.download = item.file.name;
  const canShare = typeof navigator.share === "function" && navigator.canShare?.({files:[item.file]});
  shareVideo.hidden = !canShare;
  resultNotice.textContent = item.warning || (canShare ? "点「保存或分享」，在分享菜单选择存储视频。" : "点「下载文件」，把视频存到本机。");
  lastVideo.hidden = !hasRecent();
  screen(reviewScreen);
}

function handleStop(result) {
  captureMode = "idle";
  capture = undefined;
  dropCamera();
  if (result.file) showClip(result);
  else { screen(editorScreen); setNotice(result.error || "录制未能完成"); }
}

function finishRecording() {
  if (captureMode !== "recording") return;
  captureMode = "saving";
  renderRecord();
  capture?.stop();
}

async function onRecord() {
  if (captureMode === "recording") { finishRecording(); return; }
  if (!stream || captureMode !== "idle" || mode === "loading") return;
  if (hasUnsaved() && !window.confirm("上一段视频还在这里。开始新的录制前，你可以返回保存上一段。确定开始新录制吗？")) return;
  const token = scene;
  captureMode = "preparing";
  renderRecord();
  let prepared;
  try {
    prepared = await makeRecorder(stream,handleStop);
    if (scene !== token || !stream?.active) {
      await prepared.discardUnused();
      if (scene === token) cameraFailure(new Error("Camera closed"));
      captureMode = "idle";
      return;
    }
    prepared.start();
    capture = prepared;
    captureMode = "recording";
    counter.hidden = false;
    const start = performance.now();
    const tick = () => {
      const seconds = Math.floor((performance.now() - start) / 1000);
      counter.querySelector("span").textContent = [Math.floor(seconds / 60), seconds % 60]
        .map(n => String(n).padStart(2,"0")).join(":");
    };
    tick();
    clock = setInterval(tick,250);
  } catch {
    await prepared?.discardUnused();
    captureMode = "idle";
    cameraNote.textContent = "未能开始录制，请重新打开相机。";
  }
  renderRecord();
}

function scriptChanged(resetIndex = true) {
  scriptCount.textContent = script.value.trim().length + " 字";
  if (!resetIndex) return;
  config.index = 0;
  persist();
  try { localStorage.setItem(scriptKey,script.value); }
  catch { setNotice("浏览器暂时无法保存话术，请保留原稿。"); }
}

let drag = null;
dragCue.addEventListener("pointerdown",event => {
  drag = {y:event.clientY, anchor:dragCue.offsetTop};
  dragCue.setPointerCapture(event.pointerId);
});
dragCue.addEventListener("pointermove",event => {
  if (!drag) return;
  config.anchor = clamp((drag.anchor + event.clientY - drag.y) / reader.clientHeight,.13,.7);
  layoutReader();
});
for (const name of ["pointerup","pointercancel"]) dragCue.addEventListener(name,() => { drag = null; persist(); });

openForm.addEventListener("submit",showCamera);
script.addEventListener("input",() => scriptChanged());
importButton.addEventListener("click",() => importInput.click());
importInput.addEventListener("change",async () => {
  const file = importInput.files[0];
  if (!file) return;
  importInput.value = "";
  try {
    const {readScript} = await import("./script-file.js");
    script.value = await readScript(file);
    scriptChanged();
    setNotice("已导入 " + file.name);
  } catch (error) { setNotice(error.message || "未能导入话术"); }
});
closeCamera.addEventListener("click",() => {
  if (captureMode === "recording") { finishRecording(); return; }
  if (captureMode === "saving") return;
  dropCamera();
  captureMode = "idle";
  screen(editorScreen);
});
first.addEventListener("click",() => manually(-current));
earlier.addEventListener("click",() => manually(-1));
later.addEventListener("click",() => manually(1));
followToggle.addEventListener("click",() => {
  if (mode === "error") { beginVoice(scene); return; }
  following = !following;
  if (following) resyncAt(current);
  setMode("ready",following ? "语音跟读中" : "跟读已暂停");
});
smaller.addEventListener("click",() => setFont(-2));
larger.addEventListener("click",() => setFont(2));
record.addEventListener("click",onRecord);
lastVideo.addEventListener("click",async () => {
  const last = await loadRecent();
  if (last) showClip(last);
  else { lastVideo.hidden = true; setNotice("浏览器里的上一段视频暂不可读取。"); }
});
doneReview.addEventListener("click",() => {
  resultVideo.pause();
  screen(editorScreen);
});
shareVideo.addEventListener("click",async () => {
  try {
    await navigator.share({files:[clip.file]});
    markSaved(clip.path);
  } catch (error) {
    if (error.name !== "AbortError") resultNotice.textContent = "分享未完成，请点「下载文件」。";
  }
});
downloadVideo.addEventListener("click",() => markSaved(clip.path));
window.addEventListener("resize",layoutReader);
document.addEventListener("visibilitychange",() => {
  if (document.visibilityState === "hidden" && captureMode === "recording") finishRecording();
});
window.addEventListener("pagehide",() => {
  if (captureMode === "recording") finishRecording();
  else dropCamera();
});
scriptChanged(false);
lastVideo.hidden = !hasRecent();
renderRecord();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./offline.js").catch(() => {});
}
