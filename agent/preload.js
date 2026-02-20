const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentAPI', {

  /* ================= SESSION ================= */
  startSession: (data) => ipcRenderer.send('start-session', data),
  endSession: () => ipcRenderer.send('end-session'),

  /* ================= ACTIVITY ================= */
  sendActivityState: (data) => ipcRenderer.send('activity-state', data),

  /* ================= LOGOUT ================= */
  logout: () => ipcRenderer.send('agent-logout')

});
