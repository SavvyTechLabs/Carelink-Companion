CareLink Companion (Windows portable)

Contents:
- node\node.exe  (copied from the machine used to build this bundle)
- tools\         (companion scripts)
- node_modules\  (production dependencies)
- start.bat       (double-click to start companion)

Usage:
1. Extract the ZIP to a folder on your Windows PC.
2. Double-click start.bat to start the companion. A console window will open and the companion will start a local server on http://127.0.0.1:8766
3. If Windows SmartScreen blocks execution, choose 'More info' â†’ 'Run anyway'.

Notes:
- This portable bundle copies the 
ode.exe from the builder's machine. If the target Windows lacks the required Visual C++ runtime, the bundled node may not run. In that case, consider using the installer from nodejs.org or request a signed official exe.
