const path = require('path');

module.exports = {
    mode: 'production',
    entry: {
        demo: './demo/src/demo',
    },
    output: {
        path: path.resolve(__dirname, 'demo'),
        filename: '[name].js',
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json'],
    },
    devtool: 'inline-source-map',
    watch: true,
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'babel-loader',
                        options: {
                            presets: [
                                [
                                    '@babel/preset-env',
                                    {
                                        useBuiltIns: 'usage',
                                        targets: '> 0.25%, last 2 versions, not dead, ie 10',
                                        corejs: '3.6.5',
                                        debug: true,
                                    },
                                ],
                                '@babel/preset-typescript',
                            ],
                            plugins: [
                                '@babel/proposal-class-properties',
                                '@babel/proposal-object-rest-spread',
                            ],
                        },
                    },
                ],
            },
        ],
    },
};
