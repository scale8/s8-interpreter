import {Interpreter} from "../../src";

const timeouts: any[] = [];
let timeoutCounter = 0;

const presets = [
    {
        key: 'timeout',
        value: `setTimeout(
   function(){
      log("later");
   },
   1000
);`,
    },
    {
        key: 'callA',
        value: `callA(function(a){
    log(a);
}, function(e) {
    log(e);
});`,
    },
    {
        key: 'callF',
        value: `callF(function(a, b){
    log(a);
    log(b);
});`,
    },
    {
        key: 'require',
        value: `var foo = "hi";
var doer = require("doer");
var get = require("get");
var defer = require("defer");
var log = require("log");
defer(function(){
    defer(function(){
        log(get());
        doer()();
    });
});`,
    }
];

const script = () => {
    //throw 'script error';
    return 'script done';
}

const log = (str: string, logTextArea: HTMLTextAreaElement) => {
    logTextArea.value = logTextArea.value + '\n' + str;
}


const runCode = (code: string, logTextArea: HTMLTextAreaElement) => {
    logTextArea.value = 'Started';

    new Interpreter(
        code,
        (interpreter, scope) => {
            interpreter.setProperty(
                scope,
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
                scope,
                'callF',
                interpreter.createNativeFunction((success: any, failure: any) => {
                    return interpreter.callFunction(success, undefined, 'sdasd', 'dsdsd');
                }),
            );
            interpreter.setProperty(
                scope,
                'log',
                interpreter.nativeToPseudo((msg: string) => {
                    log(msg, logTextArea);
                }),
            );
            interpreter.setProperty(
                scope,
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
                scope,
                "clearTimeout",
                interpreter.createNativeFunction((tid: number) => {
                    clearTimeout(timeouts[tid]);
                    delete timeouts[tid];
                })
            );
            interpreter.setProperty(
                scope,
                'require',
                interpreter.createNativeFunction((packageName: string) => {
                    switch (packageName) {
                        case 'doer':
                            return interpreter.createNativeFunction(() => {
                                return interpreter.createNativeFunction(() =>
                                    log('bla bla', logTextArea),
                                );
                            });
                        case 'get':
                            return interpreter.createNativeFunction(() => {
                                return interpreter.nativeToPseudo('hi');
                            });
                        case 'log':
                            return interpreter.createNativeFunction((msg: any) => {
                                log(msg, logTextArea);
                            });
                        case 'defer':
                            return interpreter.createNativeFunction((f: any) => {
                                setTimeout(() => {
                                    interpreter.queueFunction(f, undefined);
                                    interpreter.run();
                                }, 100);
                            });
                    }
                }),
            );
        },
    ).runAll(
        (e) => log(`Some error: ${e}`, logTextArea),
        () => log('Finished', logTextArea),
    );
};

// Run Button
document.addEventListener("DOMContentLoaded", function () {
    const codeTextArea = document.getElementById('code') as HTMLTextAreaElement | null;
    const logTextArea = document.getElementById('log') as HTMLTextAreaElement | null;
    if (codeTextArea !== null && logTextArea !== null) {
        codeTextArea.addEventListener('input',function(){
            logTextArea.value = '';
        })
        const presetSelect = document.getElementById('preset') as HTMLSelectElement | null;
        if (presetSelect !== null) {
            presets.forEach((preset) => {
                presetSelect.options[presetSelect.options.length] = new Option(preset.key, preset.value);
            });
            presetSelect.addEventListener('change',function(){
                logTextArea.value = '';
                codeTextArea.value = this.value;
            })
        }

        document.addEventListener('click', function (event: MouseEvent) {
            // If the clicked element doesn't have the right selector, bail
            if (!(event.target as HTMLElement).matches('.run-button')) return;

            // Don't follow the link
            event.preventDefault();

            // Run the code
            runCode(codeTextArea.value, logTextArea);
        }, false);
    }
});
