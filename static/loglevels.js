// Log highlighting the way CI logs do it (GitHub Actions, GitLab, Jenkins):
// - stdout and stderr look the same. Python's logging, warnings and progress bars all use
//   stderr, so stderr alone says nothing about errors.
// - Lines are highlighted by content, using the usual log levels.
// - Whether a step failed is decided only by its exit code (in the runner), never by the log.

const TRACEBACK_START = /^Traceback \(most recent call last\):/;
// Last line of a traceback: "ValueError: ...", "KeyboardInterrupt", "numpy.linalg.LinAlgError: ..."
const EXCEPTION_LINE = /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b(:|$)/;
// Level names as printed by logging ("ERROR:root:...", "2026-10-08 12:00 CRITICAL ...")
const ERROR_LEVEL = /\b(ERROR|CRITICAL|FATAL)\b/;
const WARNING_LEVEL = /\bWARN(ING)?\b/;
// Tool-style prefixes: "error: ...", "Fatal: ...", "warning: ..."
const ERROR_PREFIX = /^\s*(error|fatal)\b\s*:/i;
const WARNING_PREFIX = /^\s*warn(ing)?\b\s*:/i;
// Python warnings: "C:\...\script.py:635: UserWarning: Points is not a float type..."
// followed by exactly one indented line with the source code that caused it.
const PYTHON_WARNING = /\b[A-Z]\w*Warning:/;
// Text Python prints between the tracebacks of chained exceptions
const TRACEBACK_CHAIN = /^(During handling of the above exception|The above exception was the direct cause)/;

/**
 * Returns a classifier for one step's log. Call it with (stream, line) for every line, in order;
 * it returns {level, starts}: level is "info" | "normal" | "warning" | "error", and `starts`
 * is true for the first line of a warning or error (a traceback or a Python warning spans
 * several lines but counts once).
 */
export function createClassifier() {
  // stdout and stderr are read separately and their lines can arrive interleaved, so
  // multi-line context (tracebacks, warnings) is tracked per stream.
  const contexts = {};

  return (stream, line) => {
    if (stream === "info" || stream === "warning" || stream === "error") {
      return { level: stream, starts: stream !== "info" };   // ScriptGUI's own messages
    }
    const ctx = (contexts[stream] ??= {
      inTraceback: false,      // inside "Traceback ..." up to the exception line
      afterTraceback: false,   // just after one: chained tracebacks belong to the same error
      afterWarning: false,     // just after a Python warning: its source line follows
    });
    const wasAfterWarning = ctx.afterWarning;
    ctx.afterWarning = false;
    let level = "normal";
    let continues = false;

    if (ctx.inTraceback || TRACEBACK_START.test(line)) {
      continues = ctx.inTraceback || ctx.afterTraceback;
      ctx.inTraceback = !EXCEPTION_LINE.test(line);          // ends at the exception line
      ctx.afterTraceback = !ctx.inTraceback;
      level = "error";
    } else if (ctx.afterTraceback && (line.trim() === "" || TRACEBACK_CHAIN.test(line))) {
      level = line.trim() ? "error" : "normal";               // "During handling of ..." links the two
      continues = true;
    } else {
      ctx.afterTraceback = false;
      if (EXCEPTION_LINE.test(line) || ERROR_LEVEL.test(line) || ERROR_PREFIX.test(line)) {
        level = "error";
      } else if (PYTHON_WARNING.test(line)) {
        level = "warning";
        ctx.afterWarning = true;
      } else if (WARNING_LEVEL.test(line) || WARNING_PREFIX.test(line)) {
        level = "warning";
      } else if (wasAfterWarning && /^\s+\S/.test(line)) {
        level = "warning";                                   // the warning's source line
        continues = true;
      }
    }
    return { level, starts: (level === "warning" || level === "error") && !continues };
  };
}
