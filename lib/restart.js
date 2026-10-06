let restartHandler = null;

export function registerRestartHandler(fn) {
    restartHandler = fn;
}

export async function restartBot() {
    if (!restartHandler) {
        throw new Error('Restart handler not registered');
    }
    return await restartHandler();
}