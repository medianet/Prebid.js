'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const gulp = require('gulp');
const PluginError = require('plugin-error');
const through = require('through2');

const BUNDLE_DESTINATION_CONFIG = path.join(__dirname, '.clickio-bundle-destination.json');
const ADAPTERS_CONFIG_FILE = 'clickio_pb_adapters.json';

function getSavedBundleDestination() {
  try {
    return JSON.parse(fs.readFileSync(BUNDLE_DESTINATION_CONFIG, 'utf8')).path;
  } catch {
    return null;
  }
}

function getBundleFileName(argv) {
  let outputFileName = argv.bundleName ? argv.bundleName : 'prebid.js';

  if (argv.tag && argv.tag.length) {
    outputFileName = outputFileName.replace(/\.js$/, `.${argv.tag}.js`);
  }

  return outputFileName;
}

function askForBundleDestination(savedDestination) {
  const prompt = savedDestination
    ? `Bundle destination [${savedDestination}] (press Enter to use it): `
    : 'Bundle destination: ';
  const input = readline.createInterface({input: process.stdin, output: process.stdout});

  return new Promise((resolve) => {
    input.question(prompt, (answer) => {
      input.close();
      resolve(answer.trim() || savedDestination);
    });
  });
}

async function getBundleDestination() {
  const destination = await askForBundleDestination(getSavedBundleDestination());

  if (!destination) {
    throw new PluginError('bundle', 'A bundle destination is required.');
  }

  const absoluteDestination = path.resolve(__dirname, destination);
  fs.writeFileSync(BUNDLE_DESTINATION_CONFIG, JSON.stringify({path: absoluteDestination}, null, 2) + '\n');
  return absoluteDestination;
}

function bundleFilesOnly(bundleFileName) {
  return through.obj(function (file, _, done) {
    if (file.basename === bundleFileName) {
      this.push(file);
    }
    done();
  });
}

function copyBundle(createBundle, dev, argv, done) {
  let completed = false;
  const finish = (error) => {
    if (!completed) {
      completed = true;
      done(error);
    }
  };

  getBundleDestination()
    .then((destination) => {
      const stream = createBundle()
        .pipe(gulp.dest('build/' + (dev ? 'dev' : 'dist'), {
          sourcemaps: dev || argv.sourceMaps ? '.' : false
        }))
        .pipe(bundleFilesOnly(getBundleFileName(argv)))
        .pipe(gulp.dest(destination));

      stream.once('error', finish);
      stream.once('finish', () => {
        fs.copyFile(path.join(__dirname, ADAPTERS_CONFIG_FILE), path.join(destination, ADAPTERS_CONFIG_FILE), finish);
      });
    })
    .catch(finish);
}

module.exports = {
  copyBundle,
  getBundleFileName
};
