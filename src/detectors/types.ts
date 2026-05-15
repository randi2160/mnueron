/**
 * Tool detector interface.
 *
 * Every AI dev tool that supports MCP gets a detector that knows:
 *   - whether the tool is installed on this machine
 *   - where its MCP config file lives
 *   - how to add/remove an MCP server entry without clobbering other entries
 *
 * Adding support for a new tool = adding a new file in this directory and
 * registering it in detectors/index.ts.
 */

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface DetectorStatus {
  id: string;
  displayName: string;
  installed: boolean;
  configPath: string | null;
  configExists: boolean;
  alreadyConfigured: boolean;   // we're already registered under our name
  note?: string;                // anything notable about this tool on this machine
}

export interface InstallResult {
  ok: boolean;
  changed: boolean;             // did we actually write anything?
  message: string;
  configPath?: string;
}

export interface UninstallResult {
  ok: boolean;
  removed: boolean;
  message: string;
}

export interface ToolDetector {
  id: string;
  displayName: string;
  status(): DetectorStatus;
  install(serverName: string, entry: McpServerEntry): InstallResult;
  uninstall(serverName: string): UninstallResult;
}
