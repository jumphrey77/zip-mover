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
    await fs.ensureDir(appRoot);
    const entries = await fs.readdir(appRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mapNew = path.join(appRoot, entry.name, 'config', 'project_map.json');
      const mapOld = path.join(appRoot, entry.name, 'project_map.json');
      if (await fs.pathExists(mapNew) || await fs.pathExists(mapOld)) {
        await this._loadProject(entry.name);
      }
    }
  }

  async _loadProject(name) {
    const projectDir = this._projectDir(name);
    await this._migrateToConfigFolder(name);

    const mapPath = this._mapPath(name);
    try {
      const map = await fs.readJson(mapPath);
      map.files = this._migrateMapKeys(map.files || {}, map.destinationRoot);
      this.maps[name] = map;
      this.projects[name] = {
        name,
        // displayName allows title-only rename without touching the folder
        displayName:      map.displayName || name,
        projectDir,
        destinationRoot:  map.destinationRoot,
        // watchFolder: where incoming zips are dropped. Defaults to projectDir.
        watchFolder:      map.watchFolder || projectDir,
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

  async _migrateToConfigFolder(name) {
    const projectDir = this._projectDir(name);
    const configDir  = this._configDir(name);
    await fs.ensureDir(configDir);

    const oldMap = path.join(projectDir, 'project_map.json');
    const oldLog = path.join(projectDir, 'run_log.json');
    const newMap = this._mapPath(name);
    const newLog = this._runLogPath(name);

    if (await fs.pathExists(oldMap) && !(await fs.pathExists(newMap))) {
      await fs.move(oldMap, newMap);
    }
    if (await fs.pathExists(oldLog) && !(await fs.pathExists(newLog))) {
      await fs.move(oldLog, newLog);
    }
  }

  _migrateMapKeys(files, destinationRoot) {
    const migrated = {};
    for (const [key, tokenizedPath] of Object.entries(files)) {
      const valueBasename = path.basename(tokenizedPath);
      if (key === valueBasename) {
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

  _configDir(name) {
    return path.join(this._projectDir(name), 'config');
  }

  _mapPath(name) {
    return path.join(this._configDir(name), 'project_map.json');
  }

  _runLogPath(name) {
    return path.join(this._configDir(name), 'run_log.json');
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
    const entries = await fs.readdir(destinationRoot, { withFileTypes: true })
      .catch(e => { throw new Error(`Cannot read: ${e.message}`); });
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
    await fs.ensureDir(path.join(projectDir, 'config'));
    for (const sub of PROJECT_SUBDIRS) await fs.ensureDir(path.join(projectDir, sub));
    const map = await this._buildMap(name, destinationRoot, excludedFolders);
    this.maps[name] = map;
    this.projects[name] = {
      name,
      displayName:     name,
      projectDir,
      destinationRoot,
      watchFolder:     projectDir,   // default: same as projectDir
      nextRunNumber:   1,
      fileCount:       Object.keys(map.files).length,
      excludedFolders: map.excludedFolders,
      excludedFiles:   [],
      wildcards:       [],
      allowDropToUI:   true,
      lastRun:         null
    };
    return this.projects[name];
  }

  async deleteProject(name) {
    if (!this.projects[name]) throw new Error(`Project "${name}" not found`);
    delete this.projects[name];
    delete this.maps[name];
  }

  // ── Title-only rename — no folder changes ─────────────────────────────────
  async renameProject(name, newDisplayName) {
    const project = this.projects[name];
    const map     = this.maps[name];
    if (!project || !map) throw new Error(`Project "${name}" not found`);

    project.displayName = newDisplayName;
    map.displayName     = newDisplayName;
    await this.saveMap(name);
  }

  // ── Update watch folder ───────────────────────────────────────────────────
  async updateWatchFolder(name, watchFolder) {
    const project = this.projects[name];
    const map     = this.maps[name];
    if (!project || !map) throw new Error(`Project "${name}" not found`);

    // Ensure the folder exists (it might be on a different drive)
    await fs.ensureDir(watchFolder);

    project.watchFolder = watchFolder;
    map.watchFolder     = watchFolder;
    await this.saveMap(name);
  }

  async rebuildMap(name, newExcludedFolders) {
    const project = this.projects[name];
    if (!project) throw new Error(`Project "${name}" not found`);
    const excluded = newExcludedFolders !== undefined
      ? newExcludedFolders
      : (this.maps[name] && this.maps[name].excludedFolders) || [];
    const map = await this._buildMap(name, project.destinationRoot, excluded);
    this.maps[name] = map;
    this.projects[name].fileCount       = Object.keys(map.files).length;
    this.projects[name].excludedFolders = map.excludedFolders;
    return map;
  }

  async updateExclusionsAndRebuild(name, excludedFolders) {
    return this.rebuildMap(name, excludedFolders);
  }

  async _buildMap(name, destinationRoot, excludedFolders = []) {
    const files = {};
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
          const relKey        = path.relative(destinationRoot, fullPath);
          const tokenizedPath = '{root}' + path.sep + relKey;
          files[relKey]       = tokenizedPath;
        }
      }
    };

    await scan(destinationRoot, true);

    const existing = this.maps[name] || {};
    const map = {
      destinationRoot,
      displayName:   existing.displayName   || name,
      watchFolder:   existing.watchFolder   || this._projectDir(name),
      excludedFolders,
      excludedFiles: existing.excludedFiles || [],
      wildcards:     existing.wildcards     || [],
      allowDropToUI: existing.allowDropToUI !== undefined ? existing.allowDropToUI !== false : true,
      nextRunNumber: existing.nextRunNumber || 1,
      builtAt:       new Date().toISOString(),
      fileCount:     Object.keys(files).length,
      collisions:    [],
      files
    };

    await fs.ensureDir(this._configDir(name));
    await fs.writeJson(this._mapPath(name), map, { spaces: 2 });
    return map;
  }

  // ── Lookup helpers ────────────────────────────────────────────────────────
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

  findBestMatch(projectName, filename, zipInternalPath) {
    const matches = this.findByFilename(projectName, filename);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    if (zipInternalPath) {
      const zipDir = path.dirname(zipInternalPath).replace(/\//g, path.sep).toLowerCase();
      let best = null, bestScore = -1;
      for (const m of matches) {
        const mapDir   = path.dirname(m.relKey).toLowerCase();
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

    return null;
  }

  // ── Map entry operations ──────────────────────────────────────────────────
  async updateMapEntry(projectName, relKey, destination) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    map.files[relKey] = destination;
    map.fileCount     = Object.keys(map.files).length;
    await fs.writeJson(this._mapPath(projectName), map, { spaces: 2 });
  }

  async addFileToMap(projectName, relKey, tokenizedPath) {
    const map = this.maps[projectName];
    if (!map) return;
    map.files[relKey] = tokenizedPath;
    map.fileCount     = Object.keys(map.files).length;
    await this.saveMap(projectName);
  }

  async updateProjectSettings(name, settings) {
    const map     = this.maps[name];
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
      .replaceAll('{root}', map.destinationRoot)
      .replaceAll('{filename}', filename);
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
    const map     = this.maps[projectName];
    const project = this.projects[projectName];
    const run     = map.nextRunNumber || 1;
    map.nextRunNumber     = run + 1;
    project.nextRunNumber = map.nextRunNumber;
    return run;
  }

  async resetRunNumber(projectName) {
    const map     = this.maps[projectName];
    const project = this.projects[projectName];
    if (!map) return;
    map.nextRunNumber = 1;
    if (project) { project.nextRunNumber = 1; project.lastRun = null; }
    await this.saveMap(projectName);
  }

  async saveMap(projectName) {
    const map = this.maps[projectName];
    if (!map) return;
    await fs.writeJson(this._mapPath(projectName), map, { spaces: 2 });
  }

  async logRun(projectName, runEntry) {
    const runLogPath = this._runLogPath(projectName);
    let log = [];
    if (await fs.pathExists(runLogPath)) log = await fs.readJson(runLogPath);
    log.push(runEntry);
    await fs.writeJson(runLogPath, log, { spaces: 2 });
    this.projects[projectName].lastRun = runEntry;
  }

  async _readRunLog(projectName) {
    const runLogPath = this._runLogPath(projectName);
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
