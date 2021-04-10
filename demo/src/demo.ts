import {Interpreter} from "../../src";

const timeouts: any[] = [];
let timeoutCounter = 0;

let script = () => {
    throw 'script error';
    return 'script done';
}

const runCode = (code: string) => {
    new Interpreter(
        code,
        (interpreter, globalObject) => {
            interpreter.setProperty(
                globalObject,
                'callA',
                interpreter.createNativeFunction((success: any, failure: any) => {
                    setTimeout(() => {
                        try {
                            const v = script();
                            interpreter.queueFunction(success, undefined, v);
                            interpreter.run(); // Keep running
                        } catch (e) {
                            interpreter.queueFunction(success, undefined, e);
                            interpreter.run(); // Keep running
                        }
                    }, 100)
                }),
            );
            interpreter.setProperty(
                globalObject,
                'callF',
                interpreter.createNativeFunction((success: any, failure: any) => {
                    return interpreter.callFunction(success,undefined,'sdasd', 'dsdsd');
                }),
            );
            interpreter.setProperty(
                globalObject,
                'log',
                interpreter.nativeToPseudo((msg: string) => {
                    console.log(msg);
                }),
            );
            interpreter.setProperty(
                globalObject,
                'setTimeout',
                interpreter.createNativeFunction(function (fn: any, time: number) {
                    const tid = ++timeoutCounter;
                    timeouts[tid] = setTimeout(function () {
                        if (timeouts[tid]) {
                            delete timeouts[tid];
                            interpreter.queueFunction(fn);
                            interpreter.run(); // Keep running
                        }
                    }, time);
                    return tid;
                })
            );
            interpreter.setProperty(
                globalObject,
                "clearTimeout",
                interpreter.createNativeFunction((tid: number) => {
                    clearTimeout(timeouts[tid]);
                    delete timeouts[tid];
                })
            );
        },
    ).runAll(
        (e) => console.log('Some error', e),
        () => console.log('Finished'),
    );
};

// Run Button
document.addEventListener("DOMContentLoaded", function() {
    document.addEventListener('click', function (event: MouseEvent) {
        // If the clicked element doesn't have the right selector, bail
        if (!(event.target as HTMLElement).matches('.run-button')) return;

        // Don't follow the link
        event.preventDefault();

        const codeTextArea = document.getElementById('code') as HTMLTextAreaElement | null;

        if (codeTextArea !== null) {
            // Run the code
            runCode(codeTextArea.value);
        }
    }, false);
});
