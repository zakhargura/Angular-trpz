"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureI18nBuild = exports.createI18nOptions = void 0;
const core_1 = require("@angular-devkit/core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const rimraf = require("rimraf");
const read_tsconfig_1 = require("../utils/read-tsconfig");
const load_translations_1 = require("./load-translations");
function normalizeTranslationFileOption(option, locale, expectObjectInError) {
    if (typeof option === 'string') {
        return [option];
    }
    if (Array.isArray(option) && option.every((element) => typeof element === 'string')) {
        return option;
    }
    let errorMessage = `Project i18n locales translation field value for '${locale}' is malformed. `;
    if (expectObjectInError) {
        errorMessage += 'Expected a string, array of strings, or object.';
    }
    else {
        errorMessage += 'Expected a string or array of strings.';
    }
    throw new Error(errorMessage);
}
function createI18nOptions(metadata, inline) {
    if (metadata.i18n !== undefined && !core_1.json.isJsonObject(metadata.i18n)) {
        throw new Error('Project i18n field is malformed. Expected an object.');
    }
    metadata = metadata.i18n || {};
    const i18n = {
        inlineLocales: new Set(),
        // en-US is the default locale added to Angular applications (https://angular.io/guide/i18n#i18n-pipes)
        sourceLocale: 'en-US',
        locales: {},
        get shouldInline() {
            return this.inlineLocales.size > 0;
        },
    };
    let rawSourceLocale;
    let rawSourceLocaleBaseHref;
    if (core_1.json.isJsonObject(metadata.sourceLocale)) {
        rawSourceLocale = metadata.sourceLocale.code;
        if (metadata.sourceLocale.baseHref !== undefined && typeof metadata.sourceLocale.baseHref !== 'string') {
            throw new Error('Project i18n sourceLocale baseHref field is malformed. Expected a string.');
        }
        rawSourceLocaleBaseHref = metadata.sourceLocale.baseHref;
    }
    else {
        rawSourceLocale = metadata.sourceLocale;
    }
    if (rawSourceLocale !== undefined) {
        if (typeof rawSourceLocale !== 'string') {
            throw new Error('Project i18n sourceLocale field is malformed. Expected a string.');
        }
        i18n.sourceLocale = rawSourceLocale;
        i18n.hasDefinedSourceLocale = true;
    }
    i18n.locales[i18n.sourceLocale] = {
        files: [],
        baseHref: rawSourceLocaleBaseHref,
    };
    if (metadata.locales !== undefined && !core_1.json.isJsonObject(metadata.locales)) {
        throw new Error('Project i18n locales field is malformed. Expected an object.');
    }
    else if (metadata.locales) {
        for (const [locale, options] of Object.entries(metadata.locales)) {
            let translationFiles;
            let baseHref;
            if (core_1.json.isJsonObject(options)) {
                translationFiles = normalizeTranslationFileOption(options.translation, locale, false);
                if (typeof options.baseHref === 'string') {
                    baseHref = options.baseHref;
                }
            }
            else {
                translationFiles = normalizeTranslationFileOption(options, locale, true);
            }
            if (locale === i18n.sourceLocale) {
                throw new Error(`An i18n locale ('${locale}') cannot both be a source locale and provide a translation.`);
            }
            i18n.locales[locale] = {
                files: translationFiles.map((file) => ({ path: file })),
                baseHref,
            };
        }
    }
    if (inline === true) {
        i18n.inlineLocales.add(i18n.sourceLocale);
        Object.keys(i18n.locales).forEach(locale => i18n.inlineLocales.add(locale));
    }
    else if (inline) {
        for (const locale of inline) {
            if (!i18n.locales[locale] && i18n.sourceLocale !== locale) {
                throw new Error(`Requested locale '${locale}' is not defined for the project.`);
            }
            i18n.inlineLocales.add(locale);
        }
    }
    return i18n;
}
exports.createI18nOptions = createI18nOptions;
async function configureI18nBuild(context, options) {
    if (!context.target) {
        throw new Error('The builder requires a target.');
    }
    const buildOptions = { ...options };
    const tsConfig = read_tsconfig_1.readTsconfig(buildOptions.tsConfig, context.workspaceRoot);
    const usingIvy = tsConfig.options.enableIvy !== false;
    const metadata = await context.getProjectMetadata(context.target);
    const i18n = createI18nOptions(metadata, buildOptions.localize);
    // Until 11.0, support deprecated i18n options when not using new localize option
    // i18nFormat is automatically calculated
    if (buildOptions.localize === undefined && usingIvy) {
        mergeDeprecatedI18nOptions(i18n, buildOptions.i18nLocale, buildOptions.i18nFile);
    }
    else if (buildOptions.localize !== undefined && !usingIvy) {
        if (buildOptions.localize === true ||
            (Array.isArray(buildOptions.localize) && buildOptions.localize.length > 1)) {
            throw new Error(`Localization with multiple locales in one build is not supported with View Engine.`);
        }
        for (const deprecatedOption of ['i18nLocale', 'i18nFormat', 'i18nFile']) {
            // tslint:disable-next-line: no-any
            if (typeof buildOptions[deprecatedOption] !== 'undefined') {
                context.logger.warn(`Option 'localize' and deprecated '${deprecatedOption}' found.  Using 'localize'.`);
            }
        }
        if (buildOptions.localize === false ||
            (Array.isArray(buildOptions.localize) && buildOptions.localize.length === 0)) {
            buildOptions.i18nFile = undefined;
            buildOptions.i18nLocale = undefined;
            buildOptions.i18nFormat = undefined;
        }
    }
    // Clear deprecated options when using Ivy to prevent unintended behavior
    if (usingIvy) {
        buildOptions.i18nFile = undefined;
        buildOptions.i18nFormat = undefined;
        buildOptions.i18nLocale = undefined;
    }
    // No additional processing needed if no inlining requested and no source locale defined.
    if (!i18n.shouldInline && !i18n.hasDefinedSourceLocale) {
        return { buildOptions, i18n };
    }
    const projectRoot = path.join(context.workspaceRoot, metadata.root || '');
    const localeDataBasePath = findLocaleDataBasePath(projectRoot);
    if (!localeDataBasePath) {
        throw new Error(`Unable to find locale data within '@angular/common'. Please ensure '@angular/common' is installed.`);
    }
    // Load locale data and translations (if present)
    let loader;
    const usedFormats = new Set();
    for (const [locale, desc] of Object.entries(i18n.locales)) {
        if (!i18n.inlineLocales.has(locale) && locale !== i18n.sourceLocale) {
            continue;
        }
        let localeDataPath = findLocaleDataPath(locale, localeDataBasePath);
        if (!localeDataPath) {
            const [first] = locale.split('-');
            if (first) {
                localeDataPath = findLocaleDataPath(first.toLowerCase(), localeDataBasePath);
                if (localeDataPath) {
                    context.logger.warn(`Locale data for '${locale}' cannot be found.  Using locale data for '${first}'.`);
                }
            }
        }
        if (!localeDataPath) {
            context.logger.warn(`Locale data for '${locale}' cannot be found.  No locale data will be included for this locale.`);
        }
        else {
            desc.dataPath = localeDataPath;
        }
        if (!desc.files.length) {
            continue;
        }
        if (!loader) {
            loader = await load_translations_1.createTranslationLoader();
        }
        for (const file of desc.files) {
            const loadResult = loader(path.join(context.workspaceRoot, file.path));
            for (const diagnostics of loadResult.diagnostics.messages) {
                if (diagnostics.type === 'error') {
                    throw new Error(`Error parsing translation file '${file.path}': ${diagnostics.message}`);
                }
                else {
                    context.logger.warn(`WARNING [${file.path}]: ${diagnostics.message}`);
                }
            }
            if (loadResult.locale !== undefined && loadResult.locale !== locale) {
                context.logger.warn(`WARNING [${file.path}]: File target locale ('${loadResult.locale}') does not match configured locale ('${locale}')`);
            }
            usedFormats.add(loadResult.format);
            if (usedFormats.size > 1 && tsConfig.options.enableI18nLegacyMessageIdFormat !== false) {
                // This limitation is only for legacy message id support (defaults to true as of 9.0)
                throw new Error('Localization currently only supports using one type of translation file format for the entire application.');
            }
            file.format = loadResult.format;
            file.integrity = loadResult.integrity;
            if (desc.translation) {
                // Merge translations
                for (const [id, message] of Object.entries(loadResult.translations)) {
                    if (desc.translation[id] !== undefined) {
                        context.logger.warn(`WARNING [${file.path}]: Duplicate translations for message '${id}' when merging`);
                    }
                    desc.translation[id] = message;
                }
            }
            else {
                // First or only translation file
                desc.translation = loadResult.translations;
            }
        }
        // Legacy message id's require the format of the translations
        if (usedFormats.size > 0) {
            buildOptions.i18nFormat = [...usedFormats][0];
        }
        // Provide support for using the Ivy i18n options with VE
        if (!usingIvy) {
            i18n.veCompatLocale = buildOptions.i18nLocale = [...i18n.inlineLocales][0];
            if (buildOptions.i18nLocale !== i18n.sourceLocale) {
                if (i18n.locales[buildOptions.i18nLocale].files.length > 1) {
                    throw new Error('Localization with View Engine only supports using a single translation file per locale.');
                }
                buildOptions.i18nFile = i18n.locales[buildOptions.i18nLocale].files[0].path;
            }
            // Clear inline locales to prevent any new i18n related processing
            i18n.inlineLocales.clear();
            // Update the output path to include the locale to mimic Ivy localize behavior
            buildOptions.outputPath = path.join(buildOptions.outputPath, buildOptions.i18nLocale);
        }
    }
    // If inlining store the output in a temporary location to facilitate post-processing
    if (i18n.shouldInline) {
        const tempPath = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'angular-cli-i18n-'));
        buildOptions.outputPath = tempPath;
        // Remove temporary directory used for i18n processing
        process.on('exit', () => {
            try {
                rimraf.sync(tempPath);
            }
            catch (_a) { }
        });
    }
    return { buildOptions, i18n };
}
exports.configureI18nBuild = configureI18nBuild;
function mergeDeprecatedI18nOptions(i18n, i18nLocale, i18nFile) {
    if (i18nFile !== undefined && i18nLocale === undefined) {
        throw new Error(`Option 'i18nFile' cannot be used without the 'i18nLocale' option.`);
    }
    if (i18nLocale !== undefined) {
        i18n.inlineLocales.clear();
        i18n.inlineLocales.add(i18nLocale);
        if (i18nFile !== undefined) {
            i18n.locales[i18nLocale] = { files: [{ path: i18nFile }], baseHref: '' };
        }
        else {
            // If no file, treat the locale as the source locale
            // This mimics deprecated behavior
            i18n.sourceLocale = i18nLocale;
            i18n.locales[i18nLocale] = { files: [], baseHref: '' };
        }
        i18n.flatOutput = true;
    }
    return i18n;
}
function findLocaleDataBasePath(projectRoot) {
    try {
        const commonPath = path.dirname(require.resolve('@angular/common/package.json', { paths: [projectRoot] }));
        const localesPath = path.join(commonPath, 'locales/global');
        if (!fs.existsSync(localesPath)) {
            return null;
        }
        return localesPath;
    }
    catch (_a) {
        return null;
    }
}
function findLocaleDataPath(locale, basePath) {
    // Remove private use subtags
    const scrubbedLocale = locale.replace(/-x(-[a-zA-Z0-9]{1,8})+$/, '');
    const localeDataPath = path.join(basePath, scrubbedLocale + '.js');
    if (!fs.existsSync(localeDataPath)) {
        if (scrubbedLocale === 'en-US') {
            // fallback to known existing en-US locale data as of 9.0
            return findLocaleDataPath('en-US-POSIX', basePath);
        }
        return null;
    }
    return localeDataPath;
}
