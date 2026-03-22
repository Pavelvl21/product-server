const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

class Logger {
  static info(message, context = {}) {
    const contextStr = Object.keys(context).length ? ` [${JSON.stringify(context)}]` : '';
    console.log(`${colors.green}ℹ️${colors.reset} ${message}${contextStr}`);
  }
  
  static error(message, error = null, context = {}) {
    const contextStr = Object.keys(context).length ? ` [${JSON.stringify(context)}]` : '';
    console.error(`${colors.red}❌${colors.reset} ${message}${contextStr}`);
    if (error && error.stack) {
      console.error(`${colors.red}   Stack:${colors.reset} ${error.stack}`);
    }
  }
  
  static warn(message, context = {}) {
    const contextStr = Object.keys(context).length ? ` [${JSON.stringify(context)}]` : '';
    console.warn(`${colors.yellow}⚠️${colors.reset} ${message}${contextStr}`);
  }
  
  static debug(message, context = {}) {
    const contextStr = Object.keys(context).length ? ` [${JSON.stringify(context)}]` : '';
    console.log(`${colors.blue}🔍${colors.reset} ${message}${contextStr}`);
  }
}

export default Logger;