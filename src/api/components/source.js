'use strict';

const Promise             = require('bluebird');
const Path                = require('path');
const _                   = require('lodash');
const co                  = require('co');
const anymatch            = require('anymatch');
const Component           = require('./component');
const ComponentCollection = require('./collection');
const File                = require('../files/file');
const FileCollection      = require('../files/collection');
const Data                = require('../../core/data');
const Log                 = require('../../core/log');
const resolver            = require('../../core/resolver');
const EntitySource        = require('../../core/entities/source');

module.exports = class ComponentSource extends EntitySource {

    constructor(app){
        super('components', app);
    }

    resources() {
        let resources = [];
        for (let comp of this.flatten()) {
            resources = resources.concat(comp.resources().toArray());
        }
        return new FileCollection({}, resources);
    }

    components() {
        return super.entities();
    }

    getReferencesOf(target) {
        let refs = [];
        let handles = [];
        this.source.flatten().forEach(component => {
            if (component.id !== target.id) {
                for (let variant of component.variants()) {
                    if (variant.id !== target.id) {
                        for (let ref of variant.references) {
                            if (target.handle == ref.handle || target.alias == ref.handle) {
                                refs.push(variant.isDefault ? component : variant);
                                break;
                            }
                        }
                    }
                }
            }
        });
        return refs;
    }

    variants() {
        let items = [];
        for (let component of this.components()) {
            items = _.concat(items, component.variants().toArray());
        }
        return this.newSelf(items);
    }

    find() {
        if (this.size === 0 || arguments.length === 0) {
            return;
        }
        const args = Array.from(arguments);
        if (args.length == 1 && _.isString(args[0]) && !args[0].startsWith('@') && args[0].indexOf('.') !== -1) {
            return this.findFile(args[0]);
        }
        const isHandleFind = args.length == 1 && _.isString(args[0]) && args[0].startsWith('@');
        for (let item of this) {
            if (item.isCollection) {
                const search = item.find.apply(item, args);
                if (search) return search;
            } else if (item.isComponent) {
                const matcher = isHandleFind ? this._makePredicate.apply(null, ['handle', args[0].replace('@', '')]) : this._makePredicate.apply(null, args);
                if (matcher(item)) return item;
            }
        }
        if (isHandleFind) {
            for (let item of this.entities()) {
                let variant = item.variants().find(args[0]);
                if (variant) return variant;
            }
        }
    }

    findFile(filePath) {
        filePath = Path.resolve(filePath);
        if (this._fileTree) {
            function findFile(items) {
                for (let item of items) {
                    if (item.isFile && item.path === filePath) {
                        return item;
                    } else if (item.isDirectory) {
                        let result = findFile(item.children);
                        if (result) {
                            return result;
                        }
                    }
                }
            }

            return findFile(this._fileTree.children);
        }
    }

    resolve(context) {
        return resolver.context(context, this);
    }

    renderString(str, context) {
        return this.engine().render(null, str, context);
    }

    renderPreview(entity, preview) {
        preview = preview !== false ? preview : false;
        let context;
        if (entity.isComponent) {
            context = entity.variants().default().context;
        } else {
            context = entity.context;
        }
        return this.render(entity, context, { preview: preview });
    }

    /**
     * Main render method. Accepts a component or variant
     * and renders them appropriately.
     *
     * Rendering a component results in the rendering of the components' default variant,
     * unless the collated option is 'true' - in this case it will return a collated rendering
     * of all its variants.
     *
     * @param {Component/Variant} entity
     * @param {Object} context
     * @param {Object} opts
     * @return {Promise}
     * @api public
     */

    render(entity, context, opts) {

        opts           = opts || {};
        opts.preview   = opts.preview || opts.useLayout || false;
        opts.collate   = opts.collate  || false;
        opts.globals   = opts.globals || {};

        const self = this;

        if (!entity) {
            return Promise.reject(null);
        }
        if (_.isString(entity)) {
            let str = entity;
            if (entity.indexOf('@') === 0) {
                entity = this.find(entity);
                if (!entity) {
                    throw new Error(`Cannot find component ${str}`);
                }
            } else {
                return fs.readFileAsync(entity, 'utf8').then(content => {
                    return this.resolve(context).then((ctx) => {
                        ctx = _.defaults(ctx, opts.globals);
                        return this.engine().render(entity, content, ctx);
                    });
                });
            }
        }

        return co(function* () {
            const source = yield self.load();
            let rendered;
            if (entity.isComponent || entity.isVariant) {
                if (entity.isComponent) {
                    if (entity.isCollated && opts.collate) {
                        rendered = yield self._renderCollatedComponent(entity, context, opts.globals);
                    } else {
                        entity = entity.variants().default();
                        rendered = yield self._renderVariant(entity, context, opts.globals);
                    }
                } else {
                    rendered = yield self._renderVariant(entity, context, opts.globals);
                }
                if (opts.preview && entity.preview) {
                    let target = entity.toJSON();
                    target.component = target.isVariant ? entity.parent.toJSON() : target;
                    let layout = _.isString(opts.preview) ? opts.preview : entity.preview;
                    return yield self._wrapInLayout(rendered, layout, {}, _.defaults(opts.globals, {
                        _target: target,
                        _config: self._app.config()
                    }));
                }
                return rendered;
            } else {
                throw new Error(`Only components or variants can be rendered.`);
            }
        });
    }

    *_renderVariant(variant, context, globals) {
        context = context || variant.context;
        const content = yield variant.getContent();
        let ctx       = yield this.resolve(context);
        ctx           = _.defaults(ctx, globals);
        ctx._self     = variant.toJSON();
        ctx._config   = this._app.config();
        return this.engine().render(variant.viewPath, content, ctx);
    }

    *_renderCollatedComponent(component, context, globals) {
        context = context || {};
        return (yield component.variants().filter('isHidden', false).toArray().map(variant => {
            let ctx     = context[`@${variant.handle}`] || variant.context;
            return this.render(variant, ctx, {
                globals: globals
            }).then(markup => {
                const collator = component.collator;
                return _.isFunction(collator) ? collator(markup, variant) : markup;
            });
        })).join('\n');
    }

    *_wrapInLayout(content, identifier, context, globals) {
        let layout = this.find(identifier);
        let layoutContext, layoutContent, viewpath;
        if (!layout) {
            Log.warn(`Preview layout ${identifier} not found. Rendering component without layout.`);
            return content;
        }
        if (layout.isFile) {
            layoutContext = {};
            layoutContent = yield layout.read();
            viewpath = layout.path;
        } else {
            if (layout.isComponent) {
                layout = layout.variants().default();
            }
            layoutContext = yield this.resolve(layout.context);
            layoutContent = yield layout.getContent();
            viewpath = layout.viewPath;
        }
        layoutContext = _.defaults(layoutContext, context || {}, globals);
        layoutContext[this.get('yield')] = content;
        const renderMethod = (_.isFunction(this.engine().renderLayout)) ? 'renderLayout' : 'render';
        return this.engine()[renderMethod](viewpath, layoutContent, layoutContext);
    }

    _appendEventFileInfo(file, eventData) {
        eventData = super._appendEventFileInfo(file, eventData);
        for (let test of ['isResource', 'isTemplate', 'isReadme', 'isView', 'isVarView']) {
            if (this[test](file)) {
                eventData[test] = true;
            }
        }
        return eventData;
    }

    isTemplate(file) {
        return this.isView(file) || this.isVarView(file);
    }

    isView(file) {
        return anymatch([`**/*${this.get('ext')}`, `!**/*${this.get('splitter')}*${this.get('ext')}`, `!**/*.config.${this.get('ext')}`], this._getPath(file));
    }

    isVarView(file) {
        return anymatch(`**/*${this.get('splitter')}*${this.get('ext')}`, this._getPath(file));
    }

    isReadme(file) {
        return anymatch(`**/readme.md`, this._getPath(file));
    }

    isResource(file) {
        return anymatch(['**/*.*', `!**/*${this.get('ext')}`, `!**/*.config.{js,json,yaml,yml}`, `!**/readme.md`], this._getPath(file));
    }

    _parse(fileTree) {

        const source = this;

        const build = co.wrap(function* (dir, parent) {

            let collection;
            const children    = dir.children || [];
            const files       = children.filter(item => item.isFile);
            const directories = children.filter(item => item.isDirectory);

            const matched     = {
                directories: directories,
                files:       files,
                views:       files.filter(f => source.isView(f)),
                varViews:    files.filter(f => source.isVarView(f)),
                configs:     files.filter(f => source.isConfig(f)),
                readmes:     files.filter(f => source.isReadme(f)),
                resources:   files.filter(f => source.isResource(f)),
            };

            const dirConfig = yield EntitySource.getConfig(_.find(matched.configs, f => f.name.startsWith(dir.name)), {
                name:     dir.name,
                isHidden: dir.isHidden,
                order:    dir.order,
                dir:      dir.path,
                collated: dir.collated
            });

            // first figure out if it's a component directory or not...

            const view = _.find(matched.views, { name: dir.name });
            if (view) { // it is a component
                const nameMatch    = `${dir.name}`;
                dirConfig.view     = view.base;
                dirConfig.viewName = dir.name;
                dirConfig.viewPath = view.path;
                const resources    = new FileCollection({}, matched.resources.map(f => new File(f, source.relPath)));
                const files        = {
                    view:     view,
                    readme:   matched.readmes[0],
                    varViews: _.filter(matched.varViews, f => f.name.startsWith(nameMatch))
                };
                return Component.create(dirConfig, files, resources, parent || source);
            }

            // not a component, so go through the items and group into components and collections

            if (!parent) {
                collection = source;
                source.setProps(dirConfig);
            } else {
                collection = new ComponentCollection(dirConfig, [], parent);
                collection.setProps(dirConfig);
            }

            const collections = yield matched.directories.map(item => build(item, collection));
            const components  = yield matched.views.map(view => {
                const nameMatch = `${view.name}`;
                const configFile = _.find(matched.configs, f => f.name.startsWith(nameMatch));
                const conf    = EntitySource.getConfig(configFile, {
                    name:     view.name,
                    order:    view.order,
                    isHidden: view.isHidden,
                    view:     view.base,
                    viewName: view.name,
                    viewPath: view.path,
                    dir:      dir.path,
                });

                return conf.then(c => {
                    const files = {
                        view: view,
                        readme: null,
                        varViews: matched.varViews.filter(f => f.name.startsWith(nameMatch)),
                    };
                    const resources = new FileCollection({}, []);
                    return Component.create(c, files, resources, collection);
                });
            });

            const items = yield (_.concat(components, collections));
            collection.setItems(_.orderBy(items, ['order', 'name']));
            return collection;
        });

        return build(fileTree);
    }

}
