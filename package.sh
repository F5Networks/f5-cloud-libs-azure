#!/bin/bash
if [[ $1 == '--no-deps' ]]; then
    rm -rf node_modules
    npm install --production
fi

tar -C .. --exclude=".git*" --exclude="test" --exclude="${PWD##*/}/dist" --exclude="build" --exclude="doc" --exclude="gitHooks" -zcvf dist/f5-cloud-libs-azure.tar.gz f5-cloud-libs-azure
