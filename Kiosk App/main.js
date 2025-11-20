const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { SerialPort } = require('serialport');

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const PROJECTS_FILE_NAME = 'projects.json';
const DEFAULT_CONFIG = {
  titleCardDurationMs: 3000
};
const SERIAL_SCAN_INTERVAL_MS = 5000;

let config = { ...DEFAULT_CONFIG };
let projects = [];
let projectsFilePath = null;

let currentProjectIndex = 0;
let mainWindow = null;
let titleCardTimeoutId = null;
const titleCardTemplatePath = path.join(
  __dirname,
  'templates',
  'title-card.html'
);
let serialPort = null;
let serialScanIntervalId = null;
let serialScanInProgress = false;

function buildTitleCardUrl(project) {
  const url = new URL(pathToFileURL(titleCardTemplatePath).href);
  url.searchParams.set('title', project.title ?? 'Untitled Project');
  url.searchParams.set('author', project.author ?? 'Unknown Author');
  return url.toString();
}

function getTitleCardDurationMs() {
  const duration = Number(config.titleCardDurationMs);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return DEFAULT_CONFIG.titleCardDurationMs;
}

function showProjectAfterTitleCard(project) {
  if (!mainWindow) {
    throw new Error('Main window is not available to display the project.');
  }

  if (titleCardTimeoutId) clearTimeout(titleCardTimeoutId);
  const titleCardUrl = buildTitleCardUrl(project);
  mainWindow.loadURL(titleCardUrl);
  titleCardTimeoutId = setTimeout(() => {
    mainWindow.loadURL(project.url);
  }, getTitleCardDurationMs());
}

function loadProject(index) {
  if (!projects.length) {
    throw new Error('No projects are loaded. Check projects.json.');
  }
  const project = projects[index];
  if (!project || !project.url) {
    throw new Error(`Project at index ${index} is invalid or missing a url`);
  }

  currentProjectIndex = index;
  showProjectAfterTitleCard(project);
}

function showNextProject() {
  const nextIndex = (currentProjectIndex + 1) % projects.length;
  loadProject(nextIndex);
}

function showPreviousProject() {
  const prevIndex =
    (currentProjectIndex - 1 + projects.length) % projects.length;
  loadProject(prevIndex);
}

function handleSerialData(data) {
  if (!data) return;
  const input = data.toString('utf8');
  for (const char of input) {
    if (char === '>') {
      showNextProject();
    } else if (char === '<') {
      showPreviousProject();
    }
  }
}

function cleanupSerialPort() {
  if (!serialPort) return;

  try {
    serialPort.removeAllListeners('data');
    serialPort.removeAllListeners('error');
    serialPort.removeAllListeners('close');
    if (serialPort.isOpen) {
      serialPort.close(() => {});
    }
  } catch (err) {
    console.warn('Error while closing serial port:', err);
  } finally {
    serialPort = null;
  }
}

async function connectToSerialPort(portPath) {
  return new Promise(resolve => {
    console.log(`Attempting to connect to serial device at ${portPath}`);
    const candidatePort = new SerialPort(
      {
        path: portPath,
        baudRate: 9600,
        autoOpen: true
      },
      err => {
        if (err) {
          console.warn(`Failed to open serial port ${portPath}:`, err.message);
          resolve(false);
          return;
        }

        serialPort = candidatePort;
        serialPort.on('data', handleSerialData);
        serialPort.on('error', serialError => {
          console.warn('Serial port error:', serialError.message);
          cleanupSerialPort();
        });
        serialPort.on('close', () => {
          console.log('Serial port closed');
          cleanupSerialPort();
        });
        console.log(`Serial device connected: ${portPath}`);
        resolve(true);
      }
    );
  });
}

async function scanForSerialDevices() {
  if (serialPort || serialScanInProgress) return;

  serialScanInProgress = true;
  try {
    const ports = await SerialPort.list();
    const match = ports.find(info => {
      const pathLower = info.path?.toLowerCase() ?? '';
      return (
        pathLower.includes('usbmodem') || pathLower.includes('usb.modem')
      );
    });

    if (match) {
      await connectToSerialPort(match.path);
    }
  } catch (err) {
    console.warn('Failed to scan serial devices:', err);
  } finally {
    serialScanInProgress = false;
  }
}

function startSerialMonitoring() {
  if (serialScanIntervalId) return;

  scanForSerialDevices();
  serialScanIntervalId = setInterval(
    () => scanForSerialDevices(),
    SERIAL_SCAN_INTERVAL_MS
  );
}

function stopSerialMonitoring() {
  if (serialScanIntervalId) {
    clearInterval(serialScanIntervalId);
    serialScanIntervalId = null;
  }
  cleanupSerialPort();
}

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow = win;
  win.on('closed', () => {
    if (titleCardTimeoutId) clearTimeout(titleCardTimeoutId);
    titleCardTimeoutId = null;
    mainWindow = null;
  });

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.meta && input.key === 'ArrowRight') {
      showNextProject();
      return;
    }
    if (input.meta && input.key === 'ArrowLeft') {
      showPreviousProject();
      return;
    }
    if (input.key === 'ArrowRight') {
      showNextProject();
    } else if (input.key === 'ArrowLeft') {
      showPreviousProject();
    }
  });

  currentProjectIndex = Math.floor(Math.random() * projects.length);
  loadProject(currentProjectIndex);
}

function setupMediaPermissions(targetSession) {
  if (!targetSession) return;

  const allowMediaPermission = permission =>
    permission === 'media' ||
    permission === 'audioCapture' ||
    permission === 'videoCapture';

  targetSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (allowMediaPermission(permission)) {
        callback(true);
        return;
      }
      callback(false);
    }
  );

  if (typeof targetSession.setPermissionCheckHandler === 'function') {
    targetSession.setPermissionCheckHandler((_webContents, permission) =>
      allowMediaPermission(permission)
    );
  }
}

app.on('session-created', createdSession => {
  setupMediaPermissions(createdSession);
});

function normalizeProjectsPayload(payload) {
  if (Array.isArray(payload)) {
    return { config: {}, projects: payload };
  }
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray(payload.projects)
  ) {
    return {
      config: payload.config ?? {},
      projects: payload.projects
    };
  }
  throw new Error(
    'projects.json must be an array or an object with a "projects" array.'
  );
}

function getCandidateProjectPaths() {
  const candidates = [];
  const seen = new Set();
  const pushUnique = candidate => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  try {
    const homeDir = app.getPath('home');
    pushUnique(path.join(homeDir, 'Downloads', PROJECTS_FILE_NAME));
    pushUnique(path.join(homeDir, 'Desktop', PROJECTS_FILE_NAME));
  } catch {}

  try {
    const exeDir = path.dirname(process.execPath);
    pushUnique(path.join(exeDir, PROJECTS_FILE_NAME));
  } catch {}

  if (!app.isPackaged) {
    pushUnique(path.join(__dirname, PROJECTS_FILE_NAME));
  }

  return candidates;
}

function loadProjectsData() {
  const candidates = getCandidateProjectPaths();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    const payload = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    const normalized = normalizeProjectsPayload(payload);
    if (!normalized.projects.length) continue;

    projects = normalized.projects;
    config = { ...DEFAULT_CONFIG, ...normalized.config };
    projectsFilePath = candidate;
    return;
  }

  throw new Error(
    `Unable to locate ${PROJECTS_FILE_NAME}. Checked: ${candidates.join(', ')}`
  );
}

app.whenReady().then(() => {
  loadProjectsData();
  setupMediaPermissions(session.defaultSession);
  createWindow();
  startSerialMonitoring();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopSerialMonitoring();
});
