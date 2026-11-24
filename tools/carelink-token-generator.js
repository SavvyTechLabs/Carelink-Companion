#!/usr/bin/env node
'use strict';

const axios = require('./axios-shim');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const forge = require('node-forge');
const { chromium } = require('playwright');

const DISCOVERY_URL = 'https://clcloud.minimed.eu/connect/carepartner/v13/discover/android/3.6';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const RSA_KEY_SIZE = 2048;

function createLogger(logFn, errorFn) {
  return {
    info: typeof logFn === 'function' ? logFn : console.log,
    error: typeof errorFn === 'function' ? errorFn : console.error
  };
}

function parseArgs(argv) {
  const args = {
    region: 'EU',
    output: path.resolve(process.cwd(), 'carelink-logindata.json'),
    headless: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--region' && argv[index + 1]) {
      args.region = String(argv[index + 1]).toUpperCase();
      index += 1;
    } else if (arg === '--output' && argv[index + 1]) {
      args.output = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (arg === '--headless') {
      args.headless = true;
    }
  }

  if (!['EU', 'US'].includes(args.region)) {
    throw new Error('Region must be EU or US');
  }

  return args;
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomUuid() {
  return crypto.randomUUID();
}

function randomDeviceId() {
  return crypto.createHash('sha256').update(crypto.randomBytes(40)).digest('hex');
}

function randomAndroidModel() {
  const models = ['SM-G973F', 'SM-G988U1', 'SM-G981W', 'SM-G9600'];
  return models[Math.floor(Math.random() * models.length)];
}

function randomAlphaNumeric(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const byte of bytes) {
      if (result.length >= length) break;
      result += alphabet[byte % alphabet.length];
    }
  }
  return result;
}

function createPkceValues() {
  const verifier = base64UrlEncode(crypto.randomBytes(40)).replace(/[^A-Za-z0-9]/g, '');
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier, 'utf8').digest());
  return { verifier, challenge };
}

function parseQueryValue(url, key) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(key);
  } catch (error) {
    return null;
  }
}

function extractAuthorizationResultFromText(text, redirectUri) {
  if (!text) return null;

  const source = String(text);
  const candidates = new Set();

  if (source.includes('code=')) {
    candidates.add(source);
  }

  const quotedUrls = source.match(/([A-Za-z][A-Za-z0-9+.-]*:[^\s'"<>]+)/g) || [];
  for (const candidate of quotedUrls) {
    candidates.add(candidate);
  }

  if (redirectUri) {
    const escapedRedirect = redirectUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const redirectMatches = source.match(new RegExp(`${escapedRedirect}[^\s'"<>]*`, 'g')) || [];
    for (const candidate of redirectMatches) {
      candidates.add(candidate);
    }
  }

  const customSchemeMatches = source.match(/com\.medtronic\.carepartner:\/[^\s'"<>]*/g) || [];
  for (const candidate of customSchemeMatches) {
    candidates.add(candidate);
  }

  for (const candidate of candidates) {
    const code = parseQueryValue(candidate, 'code');
    if (!code) continue;
    const state = parseQueryValue(candidate, 'state');
    return { code, state, matchedUrl: candidate };
  }

  return null;
}

async function resolveEndpointConfig(region) {
  const discovery = (await axios.get(DISCOVERY_URL)).data;
  const targetRegion = region.toLowerCase();
  let ssoUrl = null;
  let isAuth0 = false;

  for (const config of discovery.CP || []) {
    if (String(config.region || '').toLowerCase() !== targetRegion) {
      continue;
    }

    const key = config.UseSSOConfiguration || 'SSOConfiguration';
    ssoUrl = config[key];
    isAuth0 = key.includes('Auth0');
    break;
  }

  if (!ssoUrl) {
    throw new Error(`Could not find SSO configuration for region ${region}`);
  }

  const ssoConfig = (await axios.get(ssoUrl)).data;

  let apiBaseUrl = '';
  if (isAuth0) {
    if (ssoConfig.issuer) {
      apiBaseUrl = String(ssoConfig.issuer).replace(/\/$/, '');
    } else if (ssoConfig.server) {
      apiBaseUrl = `https://${ssoConfig.server.hostname}:${ssoConfig.server.port}/${ssoConfig.server.prefix}`.replace(/\/$/, '');
    } else {
      const authPath = ssoConfig.system_endpoints && ssoConfig.system_endpoints.authorization_endpoint_path;
      if (!authPath) {
        throw new Error('Auth0 SSO config missing authorization endpoint');
      }
      apiBaseUrl = authPath.startsWith('http') ? authPath.replace(/\/[^/]*$/, '') : '';
    }
  } else {
    apiBaseUrl = `https://${ssoConfig.server.hostname}:${ssoConfig.server.port}/${ssoConfig.server.prefix}`.replace(/\/$/, '');
  }

  return { ssoConfig, apiBaseUrl, isAuth0 };
}

async function launchBrowser(headless, logger) {
  const attempts = [
    { channel: 'msedge', label: 'Microsoft Edge' },
    { channel: 'chrome', label: 'Google Chrome' },
    { channel: null, label: 'Playwright Chromium' }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      if (attempt.channel) {
        logger.info(`Trying browser: ${attempt.label}`);
        return await chromium.launch({ headless, channel: attempt.channel });
      }

      logger.info(`Trying browser: ${attempt.label}`);
      return await chromium.launch({ headless });
    } catch (error) {
      lastError = error;
      logger.info(`Browser launch failed for ${attempt.label}: ${error.message}`);
    }
  }

  throw new Error(`Could not launch a supported browser automatically. Install Microsoft Edge or Google Chrome. ${lastError ? lastError.message : ''}`.trim());
}

async function captureAuthorizationCode(loginUrl, redirectUri, headless, logger) {
  logger.info('Opening browser for CareLink login...');
  logger.info('Complete the login and any CAPTCHA in the browser window.');

  const browser = await launchBrowser(headless, logger);
  const context = await browser.newContext();
  const page = await context.newPage();
  let authResult = null;

  const tryCapture = (value, source) => {
    if (authResult) return true;
    const result = extractAuthorizationResultFromText(value, redirectUri);
    if (!result) return false;

    authResult = {
      code: result.code,
      state: result.state,
      matchedUrl: result.matchedUrl,
      source
    };
    logger.info(`Captured authorization code from ${source}`);
    return true;
  };

  page.on('console', (message) => {
    tryCapture(message.text(), 'browser console');
  });

  page.on('framenavigated', (frame) => {
    tryCapture(frame.url(), 'frame navigation');
  });

  page.on('request', (request) => {
    tryCapture(request.url(), 'request URL');
  });

  page.on('response', async (response) => {
    tryCapture(response.url(), 'response URL');
    try {
      if (response.status() >= 300 && response.status() < 400) {
        const headers = await response.allHeaders();
        if (headers && headers.location) {
          tryCapture(headers.location, 'redirect location header');
        }
      }
    } catch (error) {
      // Ignore header access issues, we have other capture paths.
    }
  });

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < REQUEST_TIMEOUT_MS) {
      if (authResult) {
        return { code: authResult.code, state: authResult.state };
      }

      if (!page.isClosed()) {
        tryCapture(page.url(), 'page URL');
      }

      try {
        await page.waitForTimeout(250);
      } catch (error) {
        if (authResult) {
          return { code: authResult.code, state: authResult.state };
        }
        if (page.isClosed()) {
          throw new Error('Browser page was closed before authorization code capture completed');
        }
        throw error;
      }
    }

    if (authResult) {
      return { code: authResult.code, state: authResult.state };
    }

    throw new Error('Timed out waiting for CareLink login to complete');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function createCsr(commonName, organizationalUnit, domainComponent, organization) {
  const keys = forge.pki.rsa.generateKeyPair(RSA_KEY_SIZE);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'commonName', value: commonName },
    { shortName: 'OU', value: organizationalUnit },
    { shortName: 'DC', value: domainComponent },
    { name: 'organizationName', value: organization }
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

function reformatCsr(pem) {
  const stripped = pem
    .replace(/-----BEGIN CERTIFICATE REQUEST-----/g, '')
    .replace(/-----END CERTIFICATE REQUEST-----/g, '')
    .replace(/\r?\n/g, '');

  const raw = Buffer.from(stripped, 'base64');
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function toFormUrlEncoded(data) {
  return new URLSearchParams(Object.entries(data).filter(([, value]) => value !== undefined && value !== null)).toString();
}

async function doLoginAuth0(endpointConfig, headless, logger) {
  const { ssoConfig, apiBaseUrl } = endpointConfig;
  const authParams = new URLSearchParams({
    client_id: ssoConfig.client.client_id,
    response_type: 'code',
    scope: ssoConfig.client.scope,
    redirect_uri: ssoConfig.client.redirect_uri,
    audience: ssoConfig.client.audience
  });

  const authorizeUrl = `${apiBaseUrl}${ssoConfig.system_endpoints.authorization_endpoint_path}?${authParams.toString()}`;
  const { code } = await captureAuthorizationCode(authorizeUrl, ssoConfig.client.redirect_uri, headless, logger);

  const tokenResponse = await axios.post(
    `${apiBaseUrl}${ssoConfig.system_endpoints.token_endpoint_path}`,
    toFormUrlEncoded({
      grant_type: 'authorization_code',
      client_id: ssoConfig.client.client_id,
      code,
      redirect_uri: ssoConfig.client.redirect_uri
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  const tokenData = tokenResponse.data;
  tokenData.client_id = ssoConfig.client.client_id;
  delete tokenData.expires_in;
  delete tokenData.token_type;
  return tokenData;
}

async function doLoginMag(endpointConfig, headless, logger) {
  const { ssoConfig, apiBaseUrl } = endpointConfig;
  const clientConfig = ssoConfig.oauth.client.client_ids[0];

  const clientInitResponse = await axios.post(
    `${apiBaseUrl}${ssoConfig.mag.system_endpoints.client_credential_init_endpoint_path}`,
    toFormUrlEncoded({
      client_id: clientConfig.client_id,
      nonce: randomUuid()
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'device-id': Buffer.from(randomDeviceId(), 'utf8').toString('base64')
      }
    }
  );

  const clientInit = clientInitResponse.data;
  const { verifier, challenge } = createPkceValues();
  const authResponse = await axios.get(
    `${apiBaseUrl}${ssoConfig.oauth.system_endpoints.authorization_endpoint_path}`,
    {
      params: {
        client_id: clientInit.client_id,
        response_type: 'code',
        display: 'social_login',
        scope: clientConfig.scope,
        redirect_uri: clientConfig.redirect_uri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: randomAlphaNumeric(22)
      }
    }
  );

  const captchaUrl = authResponse.data.providers[0].provider.auth_url;
  const { code } = await captureAuthorizationCode(captchaUrl, clientConfig.redirect_uri, headless, logger);

  const registerDeviceId = randomDeviceId();
  const androidModel = randomAndroidModel();
  const androidModelSafe = androidModel.replace(/[^A-Za-z0-9]/g, '');
  const clientAuthorization = Buffer.from(`${clientInit.client_id}:${clientInit.client_secret}`, 'utf8').toString('base64');
  const csr = reformatCsr(createCsr('socialLogin', registerDeviceId, androidModelSafe, ssoConfig.oauth.client.organization));

  const registerResponse = await axios.post(
    `${apiBaseUrl}${ssoConfig.mag.system_endpoints.device_register_endpoint_path}`,
    csr,
    {
      headers: {
        'device-name': Buffer.from(androidModel, 'utf8').toString('base64'),
        'authorization': `Bearer ${code}`,
        'cert-format': 'pem',
        'client-authorization': `Basic ${clientAuthorization}`,
        'create-session': 'true',
        'code-verifier': verifier,
        'device-id': Buffer.from(registerDeviceId, 'utf8').toString('base64'),
        'redirect-uri': clientConfig.redirect_uri,
        'Content-Type': 'application/octet-stream'
      }
    }
  );

  const tokenResponse = await axios.post(
    `${apiBaseUrl}${ssoConfig.oauth.system_endpoints.token_endpoint_path}`,
    toFormUrlEncoded({
      assertion: registerResponse.headers['id-token'],
      client_id: clientInit.client_id,
      client_secret: clientInit.client_secret,
      scope: clientConfig.scope,
      grant_type: registerResponse.headers['id-token-type']
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'mag-identifier': registerResponse.headers['mag-identifier']
      }
    }
  );

  const tokenData = tokenResponse.data;
  tokenData.client_id = clientInit.client_id;
  tokenData.client_secret = clientInit.client_secret;
  tokenData['mag-identifier'] = registerResponse.headers['mag-identifier'];
  delete tokenData.expires_in;
  delete tokenData.token_type;
  return tokenData;
}

async function writeOutput(filePath, tokenData) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(tokenData, null, 2), 'utf8');
}

async function generateCareLinkToken(options = {}) {
  const args = {
    region: String(options.region || 'EU').toUpperCase(),
    output: options.output ? path.resolve(options.output) : path.resolve(process.cwd(), 'carelink-logindata.json'),
    headless: Boolean(options.headless)
  };
  const logger = createLogger(options.log, options.errorLog);

  logger.info(`Starting CareLink login for region ${args.region}...`);

  const endpointConfig = await resolveEndpointConfig(args.region);
  const tokenData = endpointConfig.isAuth0
    ? await doLoginAuth0(endpointConfig, args.headless, logger)
    : await doLoginMag(endpointConfig, args.headless, logger);

  if (args.output) {
    await writeOutput(args.output, tokenData);
    logger.info(`CareLink login data written to ${args.output}`);
  }

  return tokenData;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await generateCareLinkToken(args);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  generateCareLinkToken,
  parseArgs,
  resolveEndpointConfig
};