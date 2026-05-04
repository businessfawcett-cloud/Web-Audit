class ConsoleMonitor {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.logs = [];
  }

  setup(page) {
    this.errors = [];
    this.warnings = [];
    this.logs = [];

    page.on('console', async (msg) => {
      const type = msg.type();
      const text = msg.text();
      const location = msg.location();

      const entry = {
        text,
        type,
        url: location?.url || '',
        line: location?.lineNumber || 0,
        column: location?.columnNumber || 0,
        timestamp: new Date().toISOString()
      };

      if (type === 'error') {
        this.errors.push(entry);
      } else if (type === 'warning') {
        this.warnings.push(entry);
      } else {
        this.logs.push(entry);
      }
    });

    page.on('pageerror', (error) => {
      this.errors.push({
        text: error.message,
        type: 'error',
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
    });

    return this;
  }

  getErrors() {
    return this.errors;
  }

  getWarnings() {
    return this.warnings;
  }

  getLogs() {
    return this.logs;
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  hasWarnings() {
    return this.warnings.length > 0;
  }

  getSummary() {
    return {
      errorCount: this.errors.length,
      warningCount: this.warnings.length,
      logCount: this.logs.length,
      errors: this.errors,
      warnings: this.warnings
    };
  }

  reset() {
    this.errors = [];
    this.warnings = [];
    this.logs = [];
  }
}

class NetworkMonitor {
  constructor() {
    this.failedRequests = [];
    this.allRequests = [];
  }

  setup(page) {
    this.failedRequests = [];
    this.allRequests = [];

    page.on('response', async (response) => {
      const status = response.status();
      const url = response.url();
      const request = response.request();

      const entry = {
        url,
        method: request.method(),
        status,
        statusText: response.statusText(),
        headers: response.headers(),
        timestamp: new Date().toISOString()
      };

      this.allRequests.push(entry);

      if (status >= 400) {
        this.failedRequests.push(entry);
      }
    });

    return this;
  }

  getFailedRequests() {
    return this.failedRequests;
  }

  getAllRequests() {
    return this.allRequests;
  }

  hasFailures() {
    return this.failedRequests.length > 0;
  }

  getFailureSummary() {
    const errors = this.failedRequests.filter(r => r.status >= 500);
    const clientErrors = this.failedRequests.filter(r => r.status >= 400 && r.status < 500);

    return {
      total: this.failedRequests.length,
      serverErrors: errors.length,
      clientErrors: clientErrors.length,
      failures: this.failedRequests
    };
  }

  reset() {
    this.failedRequests = [];
    this.allRequests = [];
  }
}

function createMonitorSet() {
  return {
    console: new ConsoleMonitor(),
    network: new NetworkMonitor()
  };
}

module.exports = {
  ConsoleMonitor,
  NetworkMonitor,
  createMonitorSet
};