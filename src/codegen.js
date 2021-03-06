/*
Copyright Netfoundry, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

import fs from 'fs';
import Mustache from 'mustache';
import beautify from 'js-beautify';
import lint from 'jshint';
import _ from 'lodash';
import * as ts from './typescript.js';
import * as flow from './flow.js';

import path from 'path';
import {fileURLToPath} from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

var normalizeName = function(id) {
    return id.replace(/\.|\-|\{|\}|\s/g, '_');
};

var getPathToMethodName = function(opts, m, path){
    if(path === '/' || path === '') {
        return m;
    }

    // clean url path for requests ending with '/'
    var cleanPath = path.replace(/\/$/, '');

    var segments = cleanPath.split('/').slice(1);
    segments = _.transform(segments, function (result, segment) {
        if (segment[0] === '{' && segment[segment.length - 1] === '}') {
            segment = 'by' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
        }
        result.push(segment);
    });
    var result = _.camelCase(segments.join('-'));
    return m.toLowerCase() + result[0].toUpperCase() + result.substring(1);
};

var getViewForSwagger2 = function(opts, type){
    var swagger = opts.swagger;
    var methods = [];
    var authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'COPY', 'HEAD', 'OPTIONS', 'LINK', 'UNLIK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND'];
    var data = {
        isES6: opts.isES6 || type === 'javascript',
        title: swagger.info.title,
        version: swagger.info.version,
        isSecure: swagger.securityDefinitions !== undefined,
        moduleName: opts.moduleName,
        className: opts.className,
        imports: opts.imports,
        domain: (swagger.schemes && swagger.schemes.length > 0 && swagger.host && swagger.basePath) ? swagger.schemes[0] + '://' + swagger.host + swagger.basePath.replace(/\/+$/g,'') : '',
        methods: [],
        definitions: []
    };

    _.forEach(swagger.paths, function(api, path){
        var globalParams = [];
        /**
         * @param {Object} op - meta data for the request
         * @param {string} m - HTTP method name - eg: 'get', 'post', 'put', 'delete'
         */
        _.forEach(api, function(op, m){
            if(m.toLowerCase() === 'parameters') {
                globalParams = op;
            }
        });
        _.forEach(api, function(op, m){
            var M = m.toUpperCase();
            if(M === '' || authorizedMethods.indexOf(M) === -1) {
                return;
            }
            var secureTypes = [];
            if(swagger.securityDefinitions !== undefined || op.security !== undefined) {
							  var mergedSecurity = _.merge([], swagger.security, op.security).map(function(security){
							      return Object.keys(security);
                });
							  if(swagger.securityDefinitions) {
									for(var sk in swagger.securityDefinitions) {
                    if(mergedSecurity.join(',').indexOf(sk) !== -1){
											secureTypes.push(swagger.securityDefinitions[sk].type);
                    }
									}
                }
            }
            var methodName = (op.operationId ? normalizeName(op.operationId) : getPathToMethodName(opts, m, path));
            // Make sure the method name is unique
            if(methods.indexOf(methodName) !== -1) {
              var i = 1;
              while(true) {
                if(methods.indexOf(methodName + '_' + i) !== -1) {
                  i++;
                } else {
                  methodName = methodName + '_' + i;
                  break;
                }
              }
            }
            methods.push(methodName);

            var method = {
                path: path,
                className: opts.className,
                methodName: methodName,
                method: M,
                isGET: M === 'GET',
                isPOST: M === 'POST',
                summary: op.description || op.summary,
                externalDocs: op.externalDocs,
                isSecure: swagger.security !== undefined || op.security !== undefined,
							  isSecureToken: secureTypes.indexOf('oauth2') !== -1,
							  isSecureApiKey: secureTypes.indexOf('apiKey') !== -1,
							  isSecureBasic: secureTypes.indexOf('basic') !== -1,
                parameters: [],
                hasParameters: false,
                headers: []
            };
					  if(method.isSecure && method.isSecureToken) {
					      data.isSecureToken = method.isSecureToken;
					  }
					  if(method.isSecure && method.isSecureApiKey) {
						    data.isSecureApiKey = method.isSecureApiKey;
					  }
					  if(method.isSecure && method.isSecureBasic) {
						    data.isSecureBasic = method.isSecureBasic;
					  }
					  var produces = op.produces || swagger.produces;
            if(produces) {
                method.headers.push({
                  name: 'Accept',
                  value: `'${produces.map(function(value) { return value; }).join(', ')}'`,
                });
            }

            var consumes = op.consumes || swagger.consumes;
            if(consumes) {
                method.headers.push({name: 'Content-Type', value: '\'' + consumes + '\'' });
            }

            var params = [];
            if(_.isArray(op.parameters)) {
                params = op.parameters;
            }
            params = params.concat(globalParams);
            _.forEach(params, function(parameter) {
                //Ignore parameters which contain the x-exclude-from-bindings extension
                if(parameter['x-exclude-from-bindings'] === true) {
                    return;
                }

                // Ignore headers which are injected by proxies & app servers
                // eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
                if (parameter['x-proxy-header']) {
                    return;
                }
                if (_.isString(parameter.$ref)) {
                    var segments = parameter.$ref.split('/');
                    parameter = swagger.parameters[segments.length === 1 ? segments[0] : segments[2] ];
                }
                parameter.camelCaseName = _.camelCase(parameter.name);
                if(parameter.enum && parameter.enum.length === 1) {
                    parameter.isSingleton = true;
                    parameter.singleton = parameter.enum[0];
                }
                if(parameter.in === 'body'){
                    parameter.isBodyParameter = true;
                } else if(parameter.in === 'path'){
                    parameter.isPathParameter = true;
                } else if(parameter.in === 'query'){
                    if(parameter['x-name-pattern']){
                        parameter.isPatternType = true;
                        parameter.pattern = parameter['x-name-pattern'];
                    }
                    parameter.isQueryParameter = true;
                } else if(parameter.in === 'header'){
                    parameter.isHeaderParameter = true;
                } else if(parameter.in === 'formData'){
                    parameter.isFormParameter = true;
                }
                parameter.tsType = ts.convertType(parameter);
                parameter.flowType = flow.convertType(parameter);
                if (parameter.type === 'integer') {
                    parameter.type = 'number';
                }
        
                parameter.cardinality = parameter.required ? '' : '?';
                method.parameters.push(parameter);
            });

            var success = 0;
            method.isInlineType = false;
            _.forEach(op.responses, function(val, key) {
                if (key.startsWith('2')) {
                    if (val.schema) {
                        method.methodTsType = ts.convertType(val.schema);
                        method.methodFlowType = flow.convertType(val.schema);
                        method.isInlineType = true;
                    } else {
                        method.methodResponse = val.description;
                    }
                }
            });
            method.hasParameters = method.parameters.length > 0;
            data.methods.push(method);
        });
    });

    _.forEach(swagger.definitions, function(definition, name){
        data.definitions.push({
            name: type === 'flow' ? flow.sanitizeReservedWords(name) : name,
            description: definition.description,
            flowType: flow.convertType(definition, swagger),
            tsType: ts.convertType(definition, swagger)
        });
    });

    return data;
};

var getViewForSwagger1 = function(opts, type){
    throw new Error("swagger 1.x not supported");
};

var getCode = function(opts, type) {
    // For Swagger Specification version 2.0 value of field 'swagger' must be a string '2.0'
    var data = opts.swagger.swagger === '2.0' ? getViewForSwagger2(opts, type) : getViewForSwagger1(opts, type);
    if (type === 'custom') {
        if (!_.isObject(opts.template) || !_.isString(opts.template.class)  || !_.isString(opts.template.method)) {
            throw new Error('Unprovided custom template. Please use the following template: template: { class: "...", method: "...", request: "..." }');
        }
    } else {
        if (!_.isObject(opts.template)) {
            opts.template = {};
        }
        var templates = __dirname + '/templates/';
        opts.template.class = opts.template.class || fs.readFileSync(templates + type + '-class.mustache', 'utf-8');
        opts.template.method = opts.template.method || fs.readFileSync(templates + (_.includes(['flow', 'typescript'], type) ? type + '-' : '') + 'method.mustache', 'utf-8');
        if(type === 'typescript') {
            opts.template.type = opts.template.type || fs.readFileSync(templates + 'type.mustache', 'utf-8');
        } else if (type === 'flow') {
          opts.template.type = opts.template.type || fs.readFileSync(templates + 'flow-type.mustache', 'utf-8');
        }
    }

    if (opts.mustache) {
        _.assign(data, opts.mustache);
    }

    var source = Mustache.render(opts.template.class, data, opts.template);
    var lintOptions = {
        browser: type === 'javascript',
        undef: true,
        strict: true,
        trailing: true,
        smarttabs: true,
        maxerr: 999
    };
    if (opts.esnext) {
        lintOptions.esnext = true;
    }

    if(type === 'javascript' || type === 'typescript' || type === 'flow') {
        opts.lint = false;
    }

    if (opts.lint === undefined || opts.lint === true) {
        lint(source, lintOptions);
        lint.errors.forEach(function(error) {
            if (error.code[0] === 'E') {
                throw new Error(error.reason + ' in ' + error.evidence + ' (' + error.code + ')');
            }
        });
    }
    if (opts.beautify === undefined || opts.beautify === true) {
        return beautify(source, { indent_size: 4, max_preserve_newlines: 2 });
    } else {
        return source;
    }
};

var getTypescriptCode = function(opts){
    if (opts.swagger.swagger !== '2.0') {
        throw 'Typescript is only supported for Swagger 2.0 specs.';
    }
    return getCode(opts, 'typescript');
};

var getJavaScriptCode = function(opts){
    return getCode(opts, 'javascript');
};


export  {
    getTypescriptCode,
    getJavaScriptCode,
};
