import chalk from "chalk";

class Logger {
  log(...args: any[]) {
    console.log(...args);
  }

  info(...args: any[]) {
    const finalArgs = args.map((arg) => chalk.blue(arg));
    console.log(...finalArgs);
  }

  success(...args: any[]) {
    const finalArgs = args.map((arg) => chalk.green(arg));
    console.log(...finalArgs);
  }

  error(...args: any[]) {
    const finalArgs = args.map((arg) => chalk.red(arg));
    console.log(...finalArgs);
  }

  warn(...args: any[]) {
    const finalArgs = args.map((arg) => chalk.yellow(arg));
    console.log(...finalArgs);
  }
}

export default new Logger();
