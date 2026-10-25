const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('promptApi', {
  submit: (value) => ipcRenderer.send('prompt:result', value),
  cancel: () => ipcRenderer.send('prompt:result', null),
});
