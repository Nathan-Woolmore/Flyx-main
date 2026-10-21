#!/usr/bin/env python3
"""Build the canonical iOS target without installing it or changing provisioning."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--simulator', action='store_true', help='Build the isolated Simulator preview, unsigned.')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
artifacts = Path(os.environ.get('FLYX_ARTIFACTS_DIR', str(repo.parent / 'Flyx Artifacts'))).resolve()
configuration = 'Debug' if args.simulator else 'Release'
label = 'Simulator' if args.simulator else 'Device'
output = artifacts / 'Builds' / 'iOS'
cache = artifacts / 'BuildCache'
output.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)
log = output / ('Flyx iOS ' + label + ' build.log')
command = ['/usr/bin/xcrun', 'xcodebuild', '-project', str(repo / 'ios/Flyx Remote/Flyx Remote.xcodeproj'), '-scheme', 'Flyx Remote', '-configuration', configuration, '-sdk', 'iphonesimulator' if args.simulator else 'iphoneos', '-destination', 'generic/platform=iOS Simulator' if args.simulator else 'generic/platform=iOS', '-derivedDataPath', str(cache / ('iOS ' + label)), '-clonedSourcePackagesDirPath', str(cache / 'SwiftPackages'), 'SYMROOT=' + str(output / 'Products'), 'OBJROOT=' + str(cache / 'iOS Intermediates')]
if args.simulator:
    command += ['CODE_SIGNING_ALLOWED=NO', 'PRODUCT_BUNDLE_IDENTIFIER=local.flyx.standalone.preview54']
with log.open('w') as stream:
    result = subprocess.run(command, cwd=repo, stdout=stream, stderr=subprocess.STDOUT)
if result.returncode:
    print('Build failed. Log:', log)
    for line in log.read_text(errors='replace').splitlines():
        if 'error:' in line:
            print(line)
    sys.exit(result.returncode)
app = output / 'Products' / (configuration + ('-iphonesimulator' if args.simulator else '-iphoneos')) / 'Flyx Remote.app'
if not args.simulator:
    for target in [app, app / 'Frameworks/GoogleCast.framework']:
        result = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(target)], capture_output=True, text=True)
        if result.returncode:
            print('Signature verification failed:', target.name)
            sys.exit(result.returncode)
print('Build succeeded:', app)
print('Log:', log)
