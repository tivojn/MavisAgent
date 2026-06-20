// Bridge a tiny safe API into the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mavis', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getOptions: () => ipcRenderer.invoke('settings:options'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  bakeReply: (text) => ipcRenderer.invoke('bake:reply', { text }),
  speak: (text) => ipcRenderer.invoke('tts:speak', { text }), // legacy fallback
  // xAI
  getXaiAccount: () => ipcRenderer.invoke('xai:account'),
  signInXai: () => ipcRenderer.invoke('xai:sign_in'),
  transcribe: (audio, mime, language) =>
    ipcRenderer.invoke('stt:transcribe', { audio, mime, language }),
});
