const gulp = require('gulp');

const webpackStream = require('webpack-stream');

const { webpack } = webpackStream;
const named = require('vinyl-named');

const paths = {
  scripts: {
    entry: ['js/libs/*'],
    dest: 'dist/'
  }
};

gulp.task('copy-js', () => {
  return gulp
  .src(paths.scripts.entry)
  .pipe(named())
  .pipe(
    webpackStream({
      stats: {
        assets: false,
        colors: true,
        version: false,
        timings: true,
        chunks: true,
        chunkModules: true
      },
      mode: 'development',
      devtool: 'hidden-source-map',
      watch: true,
      module: {
        rules: [
          {
            test: /\.js$/,
            loader: 'babel-loader',
            exclude: /node_modules/,
            query: {
              presets: ['@babel/preset-env'],
              plugins: ['@babel/plugin-transform-runtime']
            }
          }
        ]
      },
      plugins: [new webpack.NoEmitOnErrorsPlugin()]
    })
  )
  .pipe(gulp.dest(paths.scripts.dest))
});

gulp.task('watch', gulp.parallel('copy-js'));