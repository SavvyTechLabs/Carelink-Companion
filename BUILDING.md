# Building CareLink Companion

CareLink Companion is the Windows helper for the CGM Reader Homey app. It signs in to
Medtronic CareLink and serves the login data (`carelink-logindata.json`) on
`http://127.0.0.1:8766`, where the Homey pairing screen picks it up.

## Repository layout

```
tools/                       Companion sources (carelink-companion.js, token generator, tool server, build-portable.ps1)
package.json                 Dependencies and build scripts
.github/workflows/           Builds the Windows executable
README.txt                   End-user instructions for the portable bundle
```

The tools are self-contained: they only use `axios` (through `tools/axios-shim.js`, so pkg
bundles the CommonJS build), `node-forge` and `playwright`.

## Local commands

```bash
npm ci
npm run carelink:companion        # start the Companion
npm run build:carelink-companion  # build dist/carelink-companion-win-x64.exe
npm run build:portable            # build the portable ZIP (PowerShell)
```

## GitHub Actions

`build-carelink-companion.yml` builds the executable on Windows. Start it from the Actions
tab, or publish a release: the executable is then attached to that release. The Homey
pairing screen links to the latest release of this repository.
