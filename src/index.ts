import { S8Interpreter } from '*S8Interpreter';

const i: S8Interpreter = new S8Interpreter('1+1', (interpreter, scope) => {
    console.log(interpreter, scope);
});

i.run();
