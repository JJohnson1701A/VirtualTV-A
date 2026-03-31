# VirtualTV-A
Program designed to recreate the feel of TV from the 80s and 90s

📺 Virtual TV Scheduler
A personal virtual TV station. Build your own channel lineup, schedule movies and TV shows into timeslots, and watch them play back like a real broadcast — complete with a 1980s/90s-style on-screen program guide.
---
Requirements
Node.js 18 or higher
Download from nodejs.org — choose the LTS version.
To check if you already have it: open a terminal and type `node --version`
Windows 10/11 (also works on macOS and Linux)
Your video files in `.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, or `.m4v` format
---
Installation
1. Unzip the folder
Extract the `virtual-tv` folder somewhere convenient, for example:
```
C:\virtual-tv
```
2. Open a terminal in that folder
On Windows: open PowerShell or Command Prompt and run:
```powershell
cd C:\virtual-tv
```
Or right-click the `virtual-tv` folder in File Explorer and choose "Open in Terminal".
3. Install dependencies
```powershell
npm install
```
This installs everything needed for both the server and the client. It may take a minute or two the first time. If you see any errors about the client, also run:
```powershell
cd client
npm install
cd ..
```
4. Start the app
```powershell
npm run dev
```
You should see output like:
```
🎬 Virtual TV Server running at http://localhost:3001
  ➜  Local:   http://localhost:5173/
```
5. Open the app
Open your browser and go to:
```
http://localhost:5173
```
Leave the terminal window open while you use the app — closing it stops the server.
---
First-Time Setup
Step 1 — Scan your media
Go to Media Library and click Scan Folder. Point it at the folder(s) where your video files live. The scanner will find all your movies and TV episodes and add them to the library.
After scanning, open any item and use the Fetch Metadata button to pull in posters, descriptions, ratings, and episode info from TMDB/TVDB automatically.
Step 2 — Create channels
Go to Channels and click New Channel. Give it a number (like `2`), a name (like `HBO`), and a channel type (Broadcast, Basic Cable, Premium Cable, etc.).
On the Assign Media tab inside the channel editor, check off which movies and TV shows belong on that channel.
Step 3 — Schedule content
Go to Schedule, select your channel, and click any timeslot on the grid to assign a program. You can also use the Auto-Schedule button to fill a whole week automatically based on your assigned media.
Step 4 — Watch TV
Click Watch TV in the top-right corner. Use the arrow keys to change channels, or press `C` to open the channel list. Press `F` for fullscreen.
---
Keyboard Shortcuts (Watch TV)
Key	Action
`↑` / `↓`	Change channel
`C`	Toggle channel list
`M`	Toggle mute
`F`	Toggle fullscreen
```	Toggle controls bar
`Space` / `Enter`	Show program info
`Esc`	Return to home
When on the EPG (program guide) channel:
Key	Action
`+` / `=`	Switch to 16:9 widescreen layout
`-`	Switch to 4:3 layout
`}`	Switch to 90s grid style
`{`	Switch to 80s scroll style
---
Settings
Open Settings to configure:
Theme — Dark or Light mode
Accent Color — Choose from 8 colors; applies throughout the entire app
EPG Font — The on-screen guide font (place `.ttf` files in `client/public/fonts/`)
Channel Type Settings — Per-channel-type scheduling preferences, daypart rules, and show-length bias for the auto-scheduler
Safe Harbor — Automatically restrict mature content during daytime hours
---
FFmpeg (Recommended — enables HEVC/H.265 and MKV support)
The app can play H.264 `.mp4` files natively in any browser. To also play HEVC/H.265, MKV, AVI, WMV, and other formats, install FFmpeg:
Windows (easiest):
```powershell
winget install ffmpeg
```
Then restart your terminal and the app (`npm run dev`).
Windows (manual):
Download from ffmpeg.org/download.html — get the Windows build from gyan.dev or BtbN
Extract it, e.g. to `C:fmpeg\`
Add `C:fmpegin` to your system PATH (search "environment variables" in Windows)
Restart the terminal and run `npm run dev`
macOS:
```bash
brew install ffmpeg
```
Linux:
```bash
sudo apt install ffmpeg   # Debian/Ubuntu
sudo dnf install ffmpeg   # Fedora
```
Once FFmpeg is installed, the Media Library page will show a green status bar and automatically transcode any incompatible files on the fly when they play. No re-encoding is stored — transcoding happens in real time only while the file is playing.
---
API Keys (Optional)
The app ships with built-in API keys for TMDB and TVDB that work out of the box for metadata fetching. If you want to use your own keys (for example, to avoid rate limits), create a file called `.env` inside the `server` folder:
```
server\.env
```
With these contents:
```
TMDB_API_KEY=your_key_here
TVDB_API_KEY=your_key_here
```
You can get free API keys at:
TMDB: themoviedb.org/settings/api
TVDB: thetvdb.com/api-information
---
File Structure
```
virtual-tv/
├── client/          ← React frontend (Vite)
│   ├── src/
│   └── public/
│       └── fonts/   ← Put EPG .ttf fonts here
├── server/          ← Node.js/Express backend
│   ├── routes/
│   ├── db.json      ← Your library, channels, and schedule data
│   └── .env         ← Your API keys (optional)
└── package.json
```
> **Your data** is stored in `server/db.json`. Back this file up if you want to preserve your library, channels, and schedule.
---
Stopping the App
Press `Ctrl + C` in the terminal window.
Restarting
Just run `npm run dev` again from the `virtual-tv` folder.
---
Troubleshooting
Port already in use
If you see an error about port 3001 or 5173 being in use, either close the other application using that port, or change the port in `server/index.js` (for the server) or `client/vite.config.js` (for the frontend).
Videos won't play
Make sure your video files are in a supported format (`.mp4` is most compatible). `.mkv` files with H.264 video generally work; files with unusual codecs may not play in the browser.
Metadata not fetching
Check your internet connection. TMDB and TVDB require an internet connection to fetch posters and episode information.
App won't start after updating files
Stop the server (`Ctrl+C`) and run `npm run dev` again.
