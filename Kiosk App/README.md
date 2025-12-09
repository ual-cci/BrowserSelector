# BrowserSelector Kiosk App

BrowserSelector is a fullscreen Electron-based kiosk experience that showcases a curated playlist of interactive web projects. Each project appears with a customizable title card before the browser window loads the live site, making it ideal for gallery installations, demos, or classroom exhibitions.

## Key Features
- Fullscreen Chromium window with title-card interstitials to highlight project title and author.
- `projects.json` driven playlist with optional global config (e.g., `titleCardDurationMs`).
- Serial input support (e.g., microcontrollers sending `<` or `>` characters) to cycle projects hands-free.
- Keyboard navigation with both arrow keys and ⌘ + arrow shortcuts for quick manual control.
- Auto-scan for common `usbmodem` serial devices plus graceful cleanup on quit.
- Optional password protection to prevent unauthorized quitting (Command+Q on macOS, Alt+F4 on Windows/Linux).

## Getting Started
1. Install dependencies:
   ```
   npm install
   ```
2. Copy the example projects file and adapt it:
   ```
   cp projects.example.json projects.json
   ```
   Then edit `projects.json` to customize your project playlist. Provide an array of `{ title, author, url }` entries and optional `config`. When packaged, the app searches for `projects.json` in the packaged app's directory, Desktop, or Downloads folder.
3. Launch the kiosk:
   ```
   npm start
   ```
4. Build distributables for macOS (or other configured targets):
   ```
   npm run build
   ```

## Configuration Notes
- `config.titleCardDurationMs` controls how long the title card stays visible (defaults to 3000 ms).
- `config.backgroundColor` sets the fallback color behind the title card (`#080808` by default).
- `config.backgroundImagePath` can point to a local file (absolute or relative to `projects.json`) or a remote URL that will fill the viewport behind the card. Relative paths are resolved against the directory containing `projects.json`.
- `config.idleShuffleTimeoutMs` sets how long the kiosk waits (defaults to 60000 ms) before automatically loading a random project when there is no interaction.
- `config.password` (optional) sets a password required to quit the application. When set, quit shortcuts (Command+Q on macOS, Alt+F4 on Windows/Linux) will prompt for the password. If the password is incorrect or the dialog is cancelled, the app will continue running. Leave empty or omit to allow normal quit behavior.
- When packaged, the app searches for `projects.json` next to the executable, inside the `.app/Contents` directory, alongside the `.app` bundle itself, and then in `~/Desktop` and `~/Downloads` (in that order).
- Serial devices are scanned every 5 seconds; any device path containing `usbmodem` or `usb.modem` is considered a candidate.

## Credits
This project was created with help from Cursor AI, which assisted in structuring the Electron app, documenting its behavior, and polishing developer ergonomics.

