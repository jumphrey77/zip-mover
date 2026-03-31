// src/main/fileDropHandler.js
// Handles single-file and zip drops from the UI drag-and-drop zones

const path = require('path');
const fs = require('fs-extra');

class FileDropHandler {
  constructor(configManager, projectManager, zipProcessor) {
    this.config = configManager;
    this.projects = projectManager;
    this.processor = zipProcessor;
  }

  // Main entry point — called from IPC 'handle-drop'
  // Returns { action, result, conflicts } where action = 'zip'|'single'|'conflict'
  async handleDrop(projectName, filePath) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.zip') {
      return this._handleZipDrop(projectName, filePath);
    } else {
      return this._handleSingleFileDrop(projectName, filePath);
    }
  }

  async _handleZipDrop(projectName, filePath) {
    // Copy zip into the project folder so the processor can pick it up
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);

    const destZipPath = path.join(project.projectDir, path.basename(filePath));
    await fs.copy(filePath, destZipPath, { overwrite: true });

    const result = await this.processor.processZip(projectName, destZipPath);
    return { action: 'zip', result };
  }

  async _handleSingleFileDrop(projectName, filePath) {
    const filename = path.basename(filePath);
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);

    const map = this.projects.getProjectMap(projectName);
    if (!map) throw new Error(`No map for project "${projectName}"`);

    // ── BUG 3 FIX: Cross-project conflict detection ───────────────────────────
    // Old code used m.files[filename] (bare filename key) — broken after relKey refactor
    // Fix: use findByFilename() which searches by path.basename(relKey)
    const allProjects = this.projects.getAllProjects();
    const matchingProjects = allProjects.filter(p => {
      if (!p.name) return false;
      const matches = this.projects.findByFilename(p.name, filename);
      return matches.length > 0;
    });

    // If multiple DROP-enabled projects match, return conflict for UI to resolve
    if (matchingProjects.length > 1) {
      const dropEnabledMatches = matchingProjects.filter(p => {
        const m = this.projects.getProjectMap(p.name);
        return m && m.allowDropToUI !== false;
      });
      if (dropEnabledMatches.length > 1 && dropEnabledMatches.find(p => p.name !== projectName)) {
        return {
          action: 'conflict',
          filename,
          filePath,
          conflicts: dropEnabledMatches.map(p => p.name)
        };
      }
    }

    // Find matches using relative-path keys
    const matches = this.projects.findByFilename(projectName, filename);

    if (matches.length === 0) {
      // Try wildcard
      const wc = this.projects.matchWildcard(projectName, filename);
      if (wc) {
        const result = await this._deployWildcardFile(projectName, filename, filePath, wc);
        return { action: 'single', result };
      }
      // Truly unmatched — send to NewFilesDetected
      const result = await this._deployUnmatched(projectName, filename, filePath, map);
      return { action: 'single', result };
    }

    if (matches.length === 1) {
      // Unambiguous single match
      const result = await this._deploySingleFileByKey(projectName, filename, filePath, matches[0].relKey, matches[0].tokenizedPath);
      return { action: 'single', result };
    }

    // Multiple matches within same project — path conflict for UI to resolve
    return {
      action: 'conflict',
      filename,
      filePath,
      conflicts: matches.map(m => ({ project: projectName, relKey: m.relKey, dest: m.tokenizedPath })),
      type: 'path'
    };
  }

  async _deploySingleFileByKey(projectName, filename, filePath, relKey, tokenizedPath) {
    const absoluteDest = this.projects.resolveDestination(projectName, tokenizedPath);
    const cfg = this.config.getConfig();
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    const runNumber = this.projects.incrementRunNumber(projectName);
    await this.projects.saveMap(projectName);

    const runResult = {
      runNumber, zipName: filename,
      startedAt: new Date().toISOString(), finishedAt: null,
      filesDeployed: [], filesBackedUp: [], filesUnmatched: [],
      filesExcluded: [], collisionAlerts: [], errors: [],
      status: 'running', isSingleFile: true
    };

    const backupRunDir = path.join(project.projectDir, 'FileBackups', `Run${String(runNumber).padStart(3,'0')}`);
    await fs.ensureDir(backupRunDir);
    if (await fs.pathExists(absoluteDest)) {
      await fs.copy(absoluteDest, path.join(backupRunDir, filename));
      runResult.filesBackedUp.push({ filename, backedUpFrom: absoluteDest });
    }
    try {
      await fs.ensureDir(path.dirname(absoluteDest));
      await fs.copy(filePath, absoluteDest, { overwrite: true });
      runResult.filesDeployed.push({ filename, destination: absoluteDest });
      runResult.status = 'success';
    } catch (err) {
      runResult.errors.push({ filename, error: err.message });
      runResult.status = 'failed';
    }

    runResult.finishedAt = new Date().toISOString();
    await this.projects.logRun(projectName, runResult);
    await this.projects.pruneBackups(projectName, cfg.backupRetentionRuns || 10);
    return runResult;
  }

  async _deployUnmatched(projectName, filename, filePath, map) {
    // File has no map entry — send to NewFilesDetected
    const cfg = this.config.getConfig();
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    const runNumber = this.projects.incrementRunNumber(projectName);
    await this.projects.saveMap(projectName);

    const runResult = {
      runNumber,
      zipName: filename,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      filesDeployed: [],
      filesBackedUp: [],
      filesUnmatched: [],
      collisionAlerts: [],
      errors: [],
      status: 'running',
      isSingleFile: true
    };

    const unmatchedDir = path.join(project.projectDir, 'NewFilesDetected');
    await fs.ensureDir(unmatchedDir);
    await fs.copy(filePath, path.join(unmatchedDir, filename), { overwrite: true });
    runResult.filesUnmatched.push({ filename, suggestion: 'Update map to deploy next time' });
    runResult.status = 'completed_with_errors';

    runResult.finishedAt = new Date().toISOString();
    await this.projects.logRun(projectName, runResult);
    await this.projects.pruneBackups(projectName, cfg.backupRetentionRuns || 10);
    return runResult;
  }

  async _deployWildcardFile(projectName, filename, filePath, wildcardMatch) {
    const cfg = this.config.getConfig();
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    const runNumber = this.projects.incrementRunNumber(projectName);
    await this.projects.saveMap(projectName);

    const runResult = {
      runNumber,
      zipName: filename,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      filesDeployed: [],
      filesBackedUp: [],
      filesUnmatched: [],
      filesExcluded: [],
      collisionAlerts: [],
      errors: [],
      status: 'running',
      isSingleFile: true,
      wildcardMatch: wildcardMatch.pattern
    };

    const absoluteDest = this.projects.resolveWildcardDestination(projectName, wildcardMatch, filename);

    try {
      await fs.ensureDir(path.dirname(absoluteDest));
      await fs.copy(filePath, absoluteDest, { overwrite: true });

      runResult.filesDeployed.push({
        filename,
        destination: absoluteDest,
        wildcardPattern: wildcardMatch.pattern
      });
      runResult.status = 'success';

      // ── BUG 4 FIX: Add to map using relKey (relative path), not bare filename ──
      // Old: addFileToMap(projectName, filename, tokenizedPath)  ← bare filename key
      // Fix: derive proper relKey via path.relative, guard against outside-root paths
      const map = this.projects.getProjectMap(projectName);
      let relKey = path.relative(map.destinationRoot, absoluteDest);
      // path.relative returns an absolute path on Windows if dest is outside root
      if (path.isAbsolute(relKey)) {
        // Fallback: use just the filename as relKey — not ideal but safe
        relKey = filename;
      }
      const tokenizedPath = '{root}' + path.sep + relKey;
      await this.projects.addFileToMap(projectName, relKey, tokenizedPath);

    } catch (err) {
      runResult.errors.push({ filename, error: err.message });
      runResult.status = 'failed';
    }

    runResult.finishedAt = new Date().toISOString();
    await this.projects.logRun(projectName, runResult);
    await this.projects.pruneBackups(projectName, cfg.backupRetentionRuns || 10);
    return runResult;
  }

  // Called after user resolves a cross-project conflict
  async resolveConflict(projectName, filename, filePath, relKey, tokenizedPath) {
    if (relKey && tokenizedPath) {
      // Path conflict — deploy to specific relKey
      const result = await this._deploySingleFileByKey(projectName, filename, filePath, relKey, tokenizedPath);
      return { action: 'single', result };
    }
    const map = this.projects.getProjectMap(projectName);
    if (!map) throw new Error(`No map for project "${projectName}"`);
    const result = await this._deployUnmatched(projectName, filename, filePath, map);
    return { action: 'single', result };
  }
}

module.exports = FileDropHandler;
