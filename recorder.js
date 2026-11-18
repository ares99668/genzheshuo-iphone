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
  const requests = new Map();
  worker.onmessage = ({data}) => {
    const request = requests.get(data.id);
    requests.delete(data.id);
    if (!request) return;
    if (data.ok) request.resolve();
    else request.reject(new Error(data.message));
  };
  worker.onerror = () => {
    for (const request of requests.values()) request.reject(new Error("本机存储暂不可用"));
    requests.clear();
  };
  return {
    write(type, fields = {}) {
      return new Promise((resolve,reject) => {
        const id = ++serial;
        requests.set(id,{resolve,reject});
        worker.postMessage({id,type,...fields});
      });
    },
    close() { worker.terminate(); }
  };
}

function filename(ext) {
  const now = new Date();
  const stamp = [now.getFullYear(),now.getMonth() + 1,now.getDate(),now.getHours(),now.getMinutes(),now.getSeconds()]
    .map(n => String(n).padStart(2,"0")).join("-");
  return "跟着说-" + stamp + "." + ext;
}

export async function makeRecorder(stream, onStop) {
  const formats = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"];
  const preferred = formats.find(format => MediaRecorder.isTypeSupported(format));
  const settings = { videoBitsPerSecond:3_000_000, audioBitsPerSecond:128_000 };
  if (preferred) settings.mimeType = preferred;
  const recorder = new MediaRecorder(stream,settings);
  const folder = await navigator.storage?.getDirectory?.().catch(() => null);
  const path = "selfie-" + (crypto.randomUUID?.() || Date.now()) + ".bin";
  let storage = folder ? storageConnection() : null;
  let fatal;
  let warning;
  if (storage) {
    try { await storage.write("open",{name:path}); }
    catch {
      storage.close();
      storage = null;
      await folder.removeEntry(path).catch(() => {});
    }
  }

  const chunks = [];
  let count = 0;
  let writes = Promise.resolve();
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };

  recorder.addEventListener("dataavailable", ({data}) => {
    if (!data.size) return;
    count += data.size;
    if (storage) {
      writes = writes.then(() => {
        if (!fatal) return storage.write("append",{blob:data});
      }).catch(() => {
        fatal = "手机存储不足，视频未能保存";
        stop();
      });
      return;
    }
    chunks.push(data);
    if (count >= MAX_RAM && recorder.state !== "inactive") {
      warning = "录制已达到本次存储上限，已保留录好的片段。";
      stop();
    }
  });

  recorder.addEventListener("error", () => {
    warning = "录制中断，已尝试保留录好的片段。";
    stop();
  });

  recorder.addEventListener("stop", async () => {
    try {
      await writes;
      if (fatal) throw new Error(fatal);
      if (!count) throw new Error("未录到视频，请再录一段");
      const type = (recorder.mimeType || preferred || "video/mp4").split(";")[0];
      const name = filename(type === "video/mp4" ? "mp4" : "webm");
      let file;
      if (storage) {
        await storage.write("finish");
        const handle = await folder.getFileHandle(path);
        file = new File([await handle.getFile()],name,{type});
        const previous = readRecent();
        try {
          localStorage.setItem(lastKey,JSON.stringify({path,name,type,saved:false}));
          if (previous?.path && previous.path !== path) await folder.removeEntry(previous.path).catch(() => {});
        } catch { /* the current preview can still export the file */ }
      } else file = new File(chunks,name,{type});
      onStop({file, path:storage ? path : null, warning});
    } catch (error) {
      if (storage) {
        storage.close();
        storage = null;
        await folder.removeEntry(path).catch(() => {});
      }
      onStop({error:error.message});
    } finally {
      storage?.close();
    }
  },{once:true});

  return {
    start() { recorder.start(3000); },
    stop,
    async discardUnused() {
      storage?.close();
      if (storage) await folder.removeEntry(path).catch(() => {});
    }
  };
}
