import { isAbsolute } from "node:path";

const numericVersion = /^[1-9]\d*(?:\.(?:0|[1-9]\d*)){0,3}$/;
const validRequest = (value) => typeof value === "string" && (value === "stable" || numericVersion.test(value));

function parseOptions(args, { defaultBrowser, shadow = false } = {}) {
  const [browserName = defaultBrowser, ...rest] = args;
  if (!["chrome", "firefox"].includes(browserName)) throw new Error("Choose chrome or firefox as the first argument");
  const options = { browserName, requestedBrowserVersion: "stable", output: undefined, ...(shadow ? { checks: undefined, negativeBridgeWorld: false } : {}) };
  const valueFlags = new Map([["--browser-version", "requestedBrowserVersion"], ["--output", "output"], ...(shadow ? [["--checks", "checks"]] : [])]);
  const booleanFlags = new Map(shadow ? [["--negative-bridge-world", "negativeBridgeWorld"]] : []);
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (booleanFlags.has(flag)) options[booleanFlags.get(flag)] = true;
    else {
      const value = rest[++index];
      if (typeof value !== "string" || !value.trim() || value.startsWith("-")) throw new Error(`Missing value for ${flag}`);
      options[valueFlags.get(flag)] = value;
    }
  }
  if (!validRequest(options.requestedBrowserVersion)) throw new Error("--browser-version requires stable or a numeric version such as 140 or 140.0.4");
  if (options.output !== undefined && !isAbsolute(options.output)) throw new Error("--output must be an absolute directory path");
  return options;
}

export const parseBrowserProofOptions = (args) => parseOptions(args, { shadow: true });
export function parseBrowserArguments(args) {
  const { browserName, requestedBrowserVersion: browserVersion, output } = parseOptions(args, { defaultBrowser: "chrome" });
  return { browserName, browserVersion, output };
}

export function assertVersion(actualBrowserVersion, requestedBrowserVersion, minimum) {
  if (!validRequest(requestedBrowserVersion)) throw new Error("Malformed requested browser version");
  if (typeof actualBrowserVersion !== "string" || !numericVersion.test(actualBrowserVersion)) throw new Error("Missing or malformed actual browser version");
  const actual = actualBrowserVersion.split(".");
  if (requestedBrowserVersion !== "stable") {
    const requested = requestedBrowserVersion.split(".");
    if (!requested.every((component, index) => component === actual[index])) {
      throw new Error(`Requested browser ${requestedBrowserVersion}, but actually launched ${actualBrowserVersion}`);
    }
  }
  if (minimum !== undefined) {
    if (typeof minimum !== "string" || !numericVersion.test(minimum)) throw new Error("Unsupported packaged minimum browser version");
    const required = minimum.split(".");
    let comparison = 0n;
    for (let index = 0; index < Math.max(actual.length, required.length); index++) {
      comparison = BigInt(actual[index] ?? "0") - BigInt(required[index] ?? "0");
      if (comparison !== 0n) break;
    }
    if (comparison < 0n) throw new Error(`Browser ${actualBrowserVersion} is below the packaged minimum ${minimum}`);
  }
  return minimum ?? null;
}

export function assertBrowserVersion({ browserName, requestedBrowserVersion, actualBrowserVersion, manifest }) {
  if (!["chrome", "firefox"].includes(browserName)) throw new Error("Unsupported browser for version proof");
  const minimum = browserName === "chrome" ? manifest.minimum_chrome_version : manifest.browser_specific_settings?.gecko?.strict_min_version;
  return assertVersion(actualBrowserVersion, requestedBrowserVersion, minimum);
}
