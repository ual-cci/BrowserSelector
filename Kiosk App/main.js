const { app, BrowserWindow, session, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { SerialPort } = require('serialport');

app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const PROJECTS_FILE_NAME = 'projects.json';
const DEFAULT_CONFIG = {
	titleCardDurationMs: 3000,
	backgroundColor: '#080808',
	backgroundImagePath: '',
	idleShuffleTimeoutMs: 60000,
	password: ''
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
let isTitleCardVisible = false;
let titleCardLoadingPromise = null;
let missingProjectsAlertShown = false;
let idleTimerId = null;
let mouseHoldIntervalId = null;
let passwordValidated = false;
let passwordWindow = null;
let appStartTime = null;
const PASSWORD_GRACE_PERIOD_MS = 10000; // 10 seconds

function resolveBackgroundImageParam(imagePath) {
	if (!imagePath || typeof imagePath !== 'string') {
		return '';
	}
	const trimmed = imagePath.trim();
	if (!trimmed) return '';

	if (/^(https?|data):/i.test(trimmed)) {
		return trimmed;
	}

	try {
		const baseDir = projectsFilePath
			? path.dirname(projectsFilePath)
			: __dirname;
		const absolutePath = path.isAbsolute(trimmed)
			? trimmed
			: path.resolve(baseDir, trimmed);
		return pathToFileURL(absolutePath).toString();
	} catch (err) {
		console.warn('Failed to resolve background image path:', err);
		return '';
	}
}

function buildTitleCardUrl(project) {
	const url = new URL(pathToFileURL(titleCardTemplatePath).href);
	url.searchParams.set('title', project.title ?? 'Untitled Project');
	url.searchParams.set('author', project.author ?? 'Unknown Author');
	if (config.backgroundColor) {
		url.searchParams.set('bgColor', config.backgroundColor);
	}
	const bgImageParam = resolveBackgroundImageParam(
		config.backgroundImagePath ?? ''
	);
	if (bgImageParam) {
		url.searchParams.set('bgImage', bgImageParam);
	}
	return url.toString();
}

function buildTitleCardPayload(project) {
	return {
		title: project.title ?? 'Untitled Project',
		author: project.author ?? 'Unknown Author',
		backgroundColor: config.backgroundColor ?? DEFAULT_CONFIG.backgroundColor,
		backgroundImage: resolveBackgroundImageParam(
			config.backgroundImagePath ?? DEFAULT_CONFIG.backgroundImagePath
		)
	};
}

function sendTitleCardUpdate(project) {
	if (!mainWindow) return;
	const payload = buildTitleCardPayload(project);
	mainWindow.webContents.send('title-card:update', payload);
}

async function ensureTitleCardVisible(project) {
	if (!mainWindow) return;
	if (isTitleCardVisible && !titleCardLoadingPromise) {
		return;
	}
	if (titleCardLoadingPromise) {
		await titleCardLoadingPromise;
		return;
	}

	const titleCardUrl = buildTitleCardUrl(project);
	titleCardLoadingPromise = mainWindow
		.loadURL(titleCardUrl)
		.then(() => {
			isTitleCardVisible = true;
		})
		.finally(() => {
			titleCardLoadingPromise = null;
		});

	await titleCardLoadingPromise;
}

function getTitleCardDurationMs() {
	const duration = Number(config.titleCardDurationMs);
	if (Number.isFinite(duration) && duration > 0) {
		return duration;
	}
	return DEFAULT_CONFIG.titleCardDurationMs;
}

function getIdleShuffleTimeoutMs() {
	const configured = config.idleShuffleTimeoutMs;
	if (configured === null || configured === false) return 0;
	const timeout = Number(configured);
	if (Number.isFinite(timeout) && timeout > 0) {
		return timeout;
	}
	if (timeout === 0) return 0;
	return DEFAULT_CONFIG.idleShuffleTimeoutMs;
}

function resetIdleTimer() {
	if (idleTimerId) {
		clearTimeout(idleTimerId);
		idleTimerId = null;
	}

	const timeout = getIdleShuffleTimeoutMs();
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return;
	}

	idleTimerId = setTimeout(() => {
		idleTimerId = null;
		handleIdleTimeout();
	}, timeout);
}

function startMouseHoldInterval() {
	if (mouseHoldIntervalId) return;
	mouseHoldIntervalId = setInterval(() => resetIdleTimer(), 250);
}

function stopMouseHoldInterval() {
	if (!mouseHoldIntervalId) return;
	clearInterval(mouseHoldIntervalId);
	mouseHoldIntervalId = null;
}

function selectRandomProjectIndex(excludeIndex) {
	if (!projects.length) return 0;
	if (projects.length === 1) return 0;

	let idx = Math.floor(Math.random() * projects.length);
	if (idx === excludeIndex) {
		idx = (idx + 1 + Math.floor(Math.random() * (projects.length - 1))) % projects.length;
	}
	return idx;
}

function handleIdleTimeout() {
	if (!projects.length) return;
	const nextIndex = selectRandomProjectIndex(currentProjectIndex);
	loadProject(nextIndex);
}

function showProjectAfterTitleCard(project) {
	if (!mainWindow) {
		throw new Error('Main window is not available to display the project.');
	}

	if (titleCardTimeoutId) {
		clearTimeout(titleCardTimeoutId);
		titleCardTimeoutId = null;
	}

	void (async () => {
		try {
			await ensureTitleCardVisible(project);
			sendTitleCardUpdate(project);
		} catch (err) {
			console.error('Failed to prepare title card:', err);
			return;
		}

		titleCardTimeoutId = setTimeout(() => {
			if (!mainWindow) return;
			isTitleCardVisible = false;
			mainWindow
				.loadURL(project.url)
				.catch(err =>
					console.error('Failed to load project content URL:', err)
				);
		}, getTitleCardDurationMs());
	})();
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
	resetIdleTimer();
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
		if (char === 'R') {
			showNextProject();
			resetIdleTimer();
		} else if (char === 'L') {
			showPreviousProject();
			resetIdleTimer();
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

function isWithinPasswordGracePeriod() {
	if (!appStartTime) return false;
	const elapsed = Date.now() - appStartTime;
	return elapsed < PASSWORD_GRACE_PERIOD_MS;
}

function showPasswordDialog() {
	return new Promise((resolve, reject) => {
		if (!mainWindow) {
			reject(new Error('Main window not available'));
			return;
		}

		// If password window is already open, don't create another one
		if (passwordWindow && !passwordWindow.isDestroyed()) {
			reject(new Error('Password dialog already open'));
			return;
		}

		passwordWindow = new BrowserWindow({
			parent: mainWindow,
			modal: true,
			width: 400,
			height: 400,
			resizable: false,
			frame: true,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false
			}
		});

		const passwordDialogUrl = pathToFileURL(path.join(__dirname, 'templates', 'password-dialog.html')).href;
		passwordWindow.loadURL(passwordDialogUrl);

		passwordWindow.webContents.once('did-finish-load', () => {
			passwordWindow.webContents.executeJavaScript(`
				document.getElementById('password').focus();
			`);
		});

		passwordWindow.webContents.on('ipc-message', (_event, channel, password) => {
			if (channel === 'password-submit') {
				passwordWindow.close();
				passwordWindow = null;
				resolve(password);
			} else if (channel === 'password-cancel') {
				passwordWindow.close();
				passwordWindow = null;
			}
		});

		passwordWindow.on('closed', () => {
			passwordWindow = null;
			reject(new Error('Dialog cancelled'));
		});
	});
}

function createWindow() {
	const win = new BrowserWindow({
		fullscreen: true,
		kiosk: true,  // Prevents swiping away and provides stricter kiosk mode
		autoHideMenuBar: true,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		}
	});

	mainWindow = win;
	
	// Completely hide the menu bar (more effective than autoHideMenuBar alone)
	win.setMenuBarVisibility(false);
	
	// On macOS, hide the dock to prevent access to desktop
	if (process.platform === 'darwin') {
		// app.dock.hide();
	}
	
	win.on('closed', () => {
		if (titleCardTimeoutId) clearTimeout(titleCardTimeoutId);
		titleCardTimeoutId = null;
		mainWindow = null;
		stopMouseHoldInterval();
	});

	win.webContents.on('before-input-event', (_event, input) => {
		if (input.type === 'mouseDown') {
			resetIdleTimer();
			startMouseHoldInterval();
			return;
		}
		if (input.type === 'mouseUp') {
			resetIdleTimer();
			stopMouseHoldInterval();
			return;
		}
		if (input.type === 'mouseMove' || input.type === 'mouseWheel') {
			resetIdleTimer();
			return;
		}
		if (input.type !== 'keyDown') return;
		resetIdleTimer();
		
		// Handle quit shortcuts (Command+Q on Mac, Alt+F4 on Windows/Linux)
		const isQuitShortcut = 
			(input.meta && input.key === 'q') || // Command+Q on Mac
			(input.alt && input.key === 'F4');    // Alt+F4 on Windows/Linux
		
		if (isQuitShortcut) {
			const password = config.password?.trim();
			if (password && !isWithinPasswordGracePeriod()) {
				_event.preventDefault();
				void (async () => {
					try {
						const enteredPassword = await showPasswordDialog();
						if (enteredPassword === password) {
							passwordValidated = true;
							app.quit();
						}
						// If password doesn't match, silently close (no error shown)
					} catch (err) {
						// Dialog was cancelled, silently ignore
					}
				})();
				return;
			}
			// If no password is set or within grace period, allow normal quit behavior
		}
		
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

	const resetEvents = [
		'cursor-changed',
		'did-start-navigation',
		'did-navigate',
		'did-frame-finish-load',
		'paint',
		'scroll-touch-begin',
		'scroll-touch-end',
		'scroll-begin',
		'scroll-end',
		'mouse-down',
		'mouse-up',
		'mouse-enter',
		'mouse-leave',
		'pointer-lock-change',
		'mouse-wheel',
		'touch-start',
		'touch-end',
		'touch-move',
		'gesture-begin',
		'gesture-end',
		'gesture-start',
		'gestureupdate',
		'gestureend'
	];

	for (const eventName of resetEvents) {
		win.webContents.on(eventName, () => resetIdleTimer());
	}

	win.webContents.on('input-event', () => resetIdleTimer());

	win.on('blur', () => stopMouseHoldInterval());
	win.on('leave-full-screen', () => stopMouseHoldInterval());

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
		const appContentsDir = path.resolve(exeDir, '..');
		pushUnique(path.join(appContentsDir, PROJECTS_FILE_NAME));
		const appBundleDir = path.resolve(appContentsDir, '../..');
		pushUnique(path.join(appBundleDir, PROJECTS_FILE_NAME));
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

async function showMissingProjectsMessage(error) {
	if (missingProjectsAlertShown) return;
	missingProjectsAlertShown = true;
	const message = error?.message ?? 'Unable to locate projects.json.';
	const detail = [
		'BrowserSelector looks for projects.json next to the executable, on your Desktop,',
		'or in your Downloads folder. Add the file and restart the app.'
	].join(' ');

	await dialog.showMessageBox({
		type: 'warning',
		title: 'projects.json Missing',
		message,
		detail,
		buttons: ['Quit'],
		defaultId: 0
	});

	app.quit();
}

app.whenReady().then(() => {
	appStartTime = Date.now();
	try {
		loadProjectsData();
	} catch (err) {
		showMissingProjectsMessage(err);
		return;
	}

	setupMediaPermissions(session.defaultSession);
	createWindow();
	startSerialMonitoring();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
	const password = config.password?.trim();
	if (password && !passwordValidated && !isWithinPasswordGracePeriod()) {
		event.preventDefault();
		// Trigger password dialog if quit was attempted through other means
		void (async () => {
			try {
				const enteredPassword = await showPasswordDialog();
				if (enteredPassword === password) {
					passwordValidated = true;
					app.quit();
				}
				// If password doesn't match, silently close (no error shown)
			} catch (err) {
				// Dialog was cancelled, silently ignore
			}
		})();
		return;
	}
	
	stopSerialMonitoring();
	if (idleTimerId) {
		clearTimeout(idleTimerId);
		idleTimerId = null;
	}
	stopMouseHoldInterval();
});
