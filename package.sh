#!/bin/bash
if [[ $1 == '--no-deps' ]]; then
    rm -rf node_modules
    npm install --production
fi

tar -C .. --exclude=".git*" --exclude="test" --exclude="${PWD##*/}/dist" --exclude="build" --exclude="doc" --exclude="gitHooks" -cf dist/f5-cloud-libs-azure.tar f5-cloud-libs-azure

# Suppress gzips timetamp in the tarball - otherwise the digest hash changes on each
# commit even if the contents do not change. This causes an infinite loop in the build scripts
# due to packages triggering each other to uptdate hashes.
gzip -nf dist/f5-cloud-libs-azure.tar
