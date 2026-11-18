const lastKey = "genzheshuo-recent-video";
const MAX_RAM = 135 * 1024 * 1024;

const readRecent = () => {
  try { return JSON.parse(localStorage.getItem(lastKey)); } catch { return null; }
};

export function hasRecent() { return Boolean(readRecent()?.path); }

export async function loadRecent() {
  const entry = readRecent();
  if (!entry?.path || !navigator.storage?.getDirectory) return null;
  try {
    const folder = await navigator.storage.getDirectory();
    const handle = await folder.getFileHandle(entry.path);
    const file = await handle.getFile();
    if (!file.size) return null;
    return { file:new File([file],entry.name,{type:entry.type}), path:entry.path };
  } catch {
    return null;
  }
}

export function markSaved(path) {
  const entry = readRecent();
  if (!entry || entry.path !== path) return;
  try { localStorage.setItem(lastKey,JSON.stringify({...entry,saved:true})); } catch {}
}

export function hasUnsaved() {
  const entry = readRecent();
  return Boolean(entry?.path && !entry.saved);
}

function storageConnection() {
  const worker = new Worker(new URL("./storage-worker.js", import.meta.url));
  let serial = 0;
  let failure;
  const requests = new Map();

  function complete(id,error) {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve();
  }

  worker.onmessage = ({data}) => complete(data.id,data.ok ? null : new Error(data.message));
  worker.onerror = () => {
    failure = new Error("本机存储暂不可用");
    for (const id of requests.keys()) complete(id,failure);
  };

  return {
    write(type,fields = {},timeout = 8000) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve,reject) => {
        const id = ++serial;
        const timer = setTimeout(() => complete(id,new Error("本机存储没有响应")),timeout);
        requests.set(id,{resolve,reject,timer});
        try { worker.postMessage({id,type,...fields}); }
        catch (error) { complete(id,error); }
      });
    },
    close() { worker.terminate(); }
  };
}

async function removeRecording(path) {
  try {
    const folder = await navigator.storage.getDirectory();
    await folder.removeEntry(path);
  } catch { /* the browser can discard temporary storage later */ }
}

async function prepareStorage(path) {
  if (!navigator.storage?.getDirectory) return null;
  let storage;
  try {
    storage = storageConnection();
    await storage.write("open",{name:path},2500);
    return storage;
  } catch {
    storage?.close();
    void removeRecording(path);
    return null;
  }
}

function filename(ext) {
  const now = new Date();
  const stamp = [now.getFullYear(),now.getMonth() + 1,now.getDate(),now.getHours(),now.getMinutes(),now.getSeconds()]
    .map(n => String(n).padStart(2,"0")).join("-");
  return "跟着说-" + stamp + "." + ext;
}

function startNativeRecorder(stream,options) {
  const recorder = new MediaRecorder(stream,options);
  recorder.start(3000);
  if (recorder.state !== "recording") throw new Error("录制未能启动");
  return recorder;
}

export function startRecorder(stream,onStop) {
  const formats = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"];
  const preferred = formats.find(format => MediaRecorder.isTypeSupported?.(format));
  const settings = { videoBitsPerSecond:3_000_000, audioBitsPerSecond:128_000 };
  if (preferred) settings.mimeType = preferred;
  let recorder;
  try { recorder = startNativeRecorder(stream,settings); }
  catch { recorder = startNativeRecorder(stream,{}); }

  // Start capture on the click. Local storage can initialize while capture is running.
  const path = "selfie-" + (crypto.randomUUID?.() || Date.now()) + ".bin";
  const storageReady = prepareStorage(path);
  const chunks = [];
  let count = 0;
  let chunkType;
  let writes = Promise.resolve();
  let fatal;
  let warning;
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };

  recorder.addEventListener("dataavailable", ({data}) => {
    if (!data.size) return;
    count += data.size;
    if (!chunkType) chunkType = data.type;
    writes = writes.then(async () => {
      if (fatal) return;
      const storage = await storageReady;
      if (storage) {
        await storage.write("append",{blob:data});
        return;
      }
      chunks.push(data);
      if (count >= MAX_RAM && recorder.state !== "inactive") {
        warning = "录制已达到本次存储上限，已保留录好的片段。";
        stop();
      }
    }).catch(() => {
      fatal = "手机存储无法写入，视频未能保存。";
      stop();
    });
  });

  recorder.addEventListener("error", () => {
    warning = "录制中断，已尝试保留录好的片段。";
    stop();
  });

  recorder.addEventListener("stop", async () => {
    const storage = await storageReady;
    let result;
    try {
      await writes;
      if (fatal) throw new Error(fatal);
      if (!count) throw new Error("未录到视频，请再试一次。");
      const type = (chunkType || recorder.mimeType || "video/mp4").split(";")[0];
      const name = filename(type === "video/mp4" ? "mp4" : "webm");
      let file;
      if (storage) {
        await storage.write("finish");
        const folder = await navigator.storage.getDirectory();
        const handle = await folder.getFileHandle(path);
        file = new File([await handle.getFile()],name,{type});
        const previous = readRecent();
        try {
          localStorage.setItem(lastKey,JSON.stringify({path,name,type,saved:false}));
          if (previous?.path && previous.path !== path) void removeRecording(previous.path);
        } catch { /* the current preview can still export the file */ }
      } else file = new File(chunks,name,{type});
      result = {file, path:storage ? path : null, warning};
    } catch (error) {
      if (storage) void removeRecording(path);
      result = {error:error.message};
    } finally {
      storage?.close();
    }
    onStop(result);
  },{once:true});

  return {stop};
}
