// src/main/projectManager.js
const path = require('path');
const fs = require('fs-extra');

const PROJECT_SUBDIRS = ['FileBackups', 'ZipArchive', 'NewFilesDetected', 'Excluded'];

class ProjectManager {
  constructor(configManager) {
    this.config = configManager;
    this.projects = {};
    this.maps = {};
  }

  async init() {
    const appRoot = this.config.getAppRoot();
    console.log('[ProjectManager] init — appRoot:', appRoot);
    await fs.ensureDir(appRoot);
    const entries = await fs.readdir(appRoot, { withFileTypes: true });
    console.log('[ProjectManager] entries in appRoot:', entries.map(e => e.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mapPath = path.join(appRoot, entry.name, 'project_map.json');
      if (await fs.pathExists(mapPath)) {
        await this._loadProject(entry.name);
        console.log('[ProjectManager] loaded project:', entry.name);
      }
    }
    console.log('[ProjectManager] total projects loaded:', Object.keys(this.projects).length);
  }

  async _loadProject(name) {
    const projectDir = this._projectDir(name);
    const mapPath = path.join(projectDir, 'project_map.json');
    try {
      const map = await fs.readJson(mapPath);
      // ── Migration: upgrade old filename-keyed maps to relative-path keys ──
      map.files = this._migrateMapKeys(map.files || {}, map.destinationRoot);
      this.maps[name] = map;
      this.projects[name] = {
        name, projectDir,
        destinationRoot:  map.destinationRoot,
        nextRunNumber:    map.nextRunNumber || 1,
        fileCount:        Object.keys(map.files).length,
        excludedFolders:  map.excludedFolders || [],
        excludedFiles:    map.excludedFiles || [],
        wildcards:        map.wildcards || [],
        allowDropToUI:    map.allowDropToUI !== false,
        lastRun:          await this._getLastRun(name)
      };
    } catch (err) {
      console.error(`Failed to load project ${name}:`, err);
    }
  }

  // ── Migration helper: detect old-style filename-only keys and warn ─────────
  // Old maps had keys like "index.ts" → "{root}\src\index.ts"
  // New maps have keys like "src\index.ts" → "{root}\src\index.ts"
  _migrateMapKeys(files, destinationRoot) {
    const migrated = {};
    for (const [key, tokenizedPath] of Object.entries(files)) {
      // If the key equals the filename portion of the value, it's old-style
      const valueBasename = path.basename(tokenizedPath);
      if (key === valueBasename) {
        // Derive the relative key from the tokenized path
        const relPath = tokenizedPath
          .replace('{root}' + path.sep, '')
          .replace('{root}/', '');
        migrated[relPath] = tokenizedPath;
      } else {
        migrated[key] = tokenizedPath;
      }
    }
    return migrated;
  }

  _projectDir(name) {
    return path.join(this.config.getAppRoot(), name);
  }

  getAllProjects() { return Object.values(this.projects); }

  async getProjectDetails(name) {
    const project = this.projects[name];
    if (!project) throw new Error(`Project "${name}" not found`);
    const runLog = await this._readRunLog(name);
    return { ...project, map: this.maps[name], runLog: runLog.slice(-50).reverse() };
  }

  getProjectMap(name) { return this.maps[name] || null; }

  async scanRootFolders(destinationRoot) {
    const results = [];
    const entries = await fs.readdir(destinationRoot, { withFileTypes: true }).catch(e => { throw new Error(`Cannot read: ${e.message}`); });
    for (const entry of entries) {
      if (entry.isDirectory()) results.push(entry.name);
    }
    return results.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  async parseGitignoreFolders(destinationRoot) {
    const gitignorePath = path.join(destinationRoot, '.gitignore');
    if (!(await fs.pathExists(gitignorePath))) return [];
    const raw = await fs.readFile(gitignorePath, 'utf8');
    const excluded = new Set();
    for (let line of raw.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      if (line.includes('*') || line.includes('?')) continue;
      const stripped = line.replace(/\/$/, '');
      if (stripped.includes('/')) continue;
      excluded.add(stripped);
    }
    return [...excluded];
  }

  async createProject(name, destinationRoot, excludedFolders = []) {
    if (this.projects[name]) throw new Error(`Project "${name}" already exists`);
    if (!name.match(/^[a-zA-Z0-9_\- ]+$/)) throw new Error('Invalid project name');
    const projectDir = this._projectDir(name);
    await fs.ensureDir(projectDir);
    for (const sub of PROJECT_SUBDIRS) await fs.ensureDir(path.join(projectDir, sub));
    const map = await this._buildMap(name, destinationRoot, excludedFolders);
    this.maps[name] = map;
    this.projects[name] = {
      name, projectDir, destinationRoot,
      nextRunNumber: 1,
      fileCount: Object.keys(map.files).length,
      excludedFolders: map.excludedFolders,
      excludedFiles: [],
      wildcards: [],
      allowDropToUI: true,
      lastRun: null
    };
    return this.projects[name];
  }

  async deleteProject(name) {
    if (!this.projects[name]) throw new Error(`Project "${name}" not found`);
    delete this.projects[name];
    delete this.maps[name];
  }

  async rebuildMap(name, newExcludedFolders) {
    const project = this.projects[name];
    if (!project) throw new Error(`Project "${name}" not found`);
    const excluded = newExcludedFolders !== undefined
      ? newExcludedFolders
      : (this.maps[name] && this.maps[name].excludedFolders) || [];
    const map = await this._buildMap(name, project.destinationRoot, excluded);
    this.maps[name] = map;
    this.projects[name].fileCount = Object.keys(map.files).length;
    this.projects[name].excludedFolders = map.excludedFolders;
    return map;
  }

  async updateExclusionsAndRebuild(name, excludedFolders) {
    return this.rebuildMap(name, excludedFolders);
  }

  async _buildMap(name, destinationRoot, excludedFolders = []) {
    const files = {};
    // No more collision tracking needed — relative path keys are unique
    const excludedSet = new Set(excludedFolders.map(f => f.toLowerCase()));

    const scan = async (dir, isRoot = false) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (e) { return; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (isRoot && excludedSet.has(entry.name.toLowerCase())) continue;
          await scan(fullPath, false);
        } else if (entry.isFile()) {
          // KEY = relative path (e.g. "src\components\index.ts")
          const relKey  = path.relative(destinationRoot, fullPath);
          const tokenizedPath = '{root}' + path.sep + relKey;
          files[relKey] = tokenizedPath;
        }
      }
    };

    await scan(destinationRoot, true);

    const map = {
      destinationRoot,
      excludedFolders,
      excludedFiles:  (this.maps[name] && this.maps[name].excludedFiles)  || [],
      wildcards:      (this.maps[name] && this.maps[name].wildcards)      || [],
      allowDropToUI:  this.maps[name] ? (this.maps[name].allowDropToUI !== false) : true,
      nextRunNumber:  (this.maps[name] && this.maps[name].nextRunNumber)  || 1,
      builtAt:        new Date().toISOString(),
      fileCount:      Object.keys(files).length,
      collisions:     [],   // always empty now — relative keys are unique
      files
    };

    await fs.writeJson(path.join(this._projectDir(name), 'project_map.json'), map, { spaces: 2 });
    return map;
  }

  // ── Lookup helpers ────────────────────────────────────────────────────────
  // Find all map entries whose filename portion matches a given name.
  // Returns array of { relKey, tokenizedPath }
  findByFilename(projectName, filename) {
    const map = this.maps[projectName];
    if (!map) return [];
    const results = [];
    for (const [relKey, tokenizedPath] of Object.entries(map.files || {})) {
      if (path.basename(relKey).toLowerCase() === filename.toLowerCase()) {
        results.push({ relKey, tokenizedPath });
      }
    }
    return results;
  }

  // Find the best single match using zip-internal path hint
  // zipInternalPath: e.g. "src/components/index.ts" from inside the zip
  findBestMatch(projectName, filename, zipInternalPath) {
    const matches = this.findByFilename(projectName, filename);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    if (zipInternalPath) {
      // Normalize separators
      const zipDir = path.dirname(zipInternalPath).replace(/\//g, path.sep).toLowerCase();
      // Score each match by how much of the zip path matches the map key folder
      let best = null, bestScore = -1;
      for (const m of matches) {
        const mapDir = path.dirname(m.relKey).toLowerCase();
        // Count matching path segments from the right
        const zipParts = zipDir.split(path.sep).filter(Boolean);
        const mapParts = mapDir.split(path.sep).filter(Boolean);
        let score = 0;
        for (let i = 0; i < Math.min(zipParts.length, mapParts.length); i++) {
          if (zipParts[zipParts.length - 1 - i] === mapParts[mapParts.length - 1 - i]) score++;
          else break;
        }
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return best;
    }

    return null;  // Ambiguous — caller must prompt user
  }

  // ── Map entry operations ──────────────────────────────────────────────────
  async updateMapEntry(projectName, relKey, destination) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    map.files[relKey] = destination;
    map.fileCount = Object.keys(map.files).length;
    await fs.writeJson(path.join(this._projectDir(projectName), 'project_map.json'), map, { spaces: 2 });
  }

  async addFileToMap(projectName, relKey, tokenizedPath) {
    const map = this.maps[projectName];
    if (!map) return;
    map.files[relKey] = tokenizedPath;
    map.fileCount = Object.keys(map.files).length;
    await this.saveMap(projectName);
  }

  async updateProjectSettings(name, settings) {
    const map = this.maps[name];
    const project = this.projects[name];
    if (!map) throw new Error(`Project "${name}" not found`);
    const allowed = ['allowDropToUI', 'excludedFiles'];
    for (const key of allowed) {
      if (settings[key] !== undefined) { map[key] = settings[key]; project[key] = settings[key]; }
    }
    await this.saveMap(name);
  }

  // ── Wildcard support ──────────────────────────────────────────────────────
  _patternToRegex(pattern) {
    let p = pattern.replace(/\[\*\]/g, '\x00SC\x00');
    p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    p = p.replace(/\x00SC\x00/g, '.');
    p = p.replace(/\*/g, '.*');
    return new RegExp('^' + p + '$', 'i');
  }

  matchWildcard(projectName, filename) {
    const map = this.maps[projectName];
    if (!map || !map.wildcards || !map.wildcards.length) return null;
    for (const wc of map.wildcards) {
      if (this._patternToRegex(wc.pattern).test(filename)) return wc;
    }
    return null;
  }

  resolveWildcardDestination(projectName, wc, filename) {
    const map = this.maps[projectName];
    if (!map) return null;
    return wc.destination
      .replace('{root}', map.destinationRoot)
      .replace('{filename}', filename);
  }

  async addWildcard(projectName, pattern, destination, description) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    if (!map.wildcards) map.wildcards = [];
    if (map.wildcards.find(w => w.pattern.toLowerCase() === pattern.toLowerCase()))
      throw new Error(`Pattern "${pattern}" already exists`);
    map.wildcards.push({ pattern, destination, description: description || '' });
    await this.saveMap(projectName);
  }

  async removeWildcard(projectName, pattern) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    map.wildcards = (map.wildcards || []).filter(w => w.pattern !== pattern);
    await this.saveMap(projectName);
  }

  async updateWildcard(projectName, oldPattern, newEntry) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    const idx = (map.wildcards || []).findIndex(w => w.pattern === oldPattern);
    if (idx === -1) throw new Error(`Pattern "${oldPattern}" not found`);
    map.wildcards[idx] = { ...map.wildcards[idx], ...newEntry };
    await this.saveMap(projectName);
  }

  // ── Destination resolution ────────────────────────────────────────────────
  resolveDestination(projectName, tokenizedPath) {
    const map = this.maps[projectName];
    if (!map) return null;
    return tokenizedPath.replace('{root}', map.destinationRoot);
  }

  // ── Run number ───────────────────────────────────────────────────────────
  incrementRunNumber(projectName) {
    const map = this.maps[projectName];
    const project = this.projects[projectName];
    const run = map.nextRunNumber || 1;
    map.nextRunNumber = run + 1;
    project.nextRunNumber = map.nextRunNumber;
    return run;
  }

  async resetRunNumber(projectName) {
    const map = this.maps[projectName];
    const project = this.projects[projectName];
    if (!map) return;
    map.nextRunNumber = 1;
    if (project) { project.nextRunNumber = 1; project.lastRun = null; }
    await this.saveMap(projectName);
  }

  async saveMap(projectName) {
    const map = this.maps[projectName];
    if (!map) return;
    await fs.writeJson(path.join(this._projectDir(projectName), 'project_map.json'), map, { spaces: 2 });
  }

  async logRun(projectName, runEntry) {
    const runLogPath = path.join(this._projectDir(projectName), 'run_log.json');
    let log = [];
    if (await fs.pathExists(runLogPath)) log = await fs.readJson(runLogPath);
    log.push(runEntry);
    await fs.writeJson(runLogPath, log, { spaces: 2 });
    this.projects[projectName].lastRun = runEntry;
  }

  async _readRunLog(projectName) {
    const runLogPath = path.join(this._projectDir(projectName), 'run_log.json');
    if (!(await fs.pathExists(runLogPath))) return [];
    return fs.readJson(runLogPath);
  }

  async _getLastRun(projectName) {
    const log = await this._readRunLog(projectName);
    return log.length > 0 ? log[log.length - 1] : null;
  }

  async pruneBackups(projectName, retentionRuns) {
    const backupDir = path.join(this._projectDir(projectName), 'FileBackups');
    if (!(await fs.pathExists(backupDir))) return;
    const runLog = await this._readRunLog(projectName);
    if (runLog.length <= retentionRuns) return;
    const runsToDelete = runLog.slice(0, runLog.length - retentionRuns);
    for (const run of runsToDelete) {
      const d = path.join(backupDir, `Run${String(run.runNumber).padStart(3,'0')}`);
      if (await fs.pathExists(d)) await fs.remove(d);
    }
  }
}

module.exports = ProjectManager;
