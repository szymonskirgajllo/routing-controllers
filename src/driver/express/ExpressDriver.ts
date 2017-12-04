import {UseMetadata} from "../../metadata/UseMetadata";
import {MiddlewareMetadata} from "../../metadata/MiddlewareMetadata";
import {ActionMetadata} from "../../metadata/ActionMetadata";
import {Action} from "../../Action";
import {ParamMetadata} from "../../metadata/ParamMetadata";
import {BaseDriver} from "../BaseDriver";
import {ExpressMiddlewareInterface} from "./ExpressMiddlewareInterface";
import {ExpressErrorMiddlewareInterface} from "./ExpressErrorMiddlewareInterface";
import {AccessDeniedError} from "../../error/AccessDeniedError";
import {AuthorizationCheckerNotDefinedError} from "../../error/AuthorizationCheckerNotDefinedError";
import {isPromiseLike} from "../../util/isPromiseLike";
import {getFromContainer} from "../../container";
import {AuthorizationRequiredError} from "../../error/AuthorizationRequiredError";
import {NotFoundError} from "../../index";

const cookie = require("cookie");
const templateUrl = require("template-url");

/**
 * Integration with express framework.
 */
export class ExpressDriver extends BaseDriver {

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(public express?: any) {
        super();
        this.loadExpress();
        this.app = this.express;
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Initializes the things driver needs before routes and middlewares registration.
     */
    initialize() {
        if (this.cors) {
            const cors = require("cors");
            if (this.cors === true) {
                this.express.use(cors());
            } else {
                this.express.use(cors(this.cors));
            }
        }
    }

    /**
     * Registers middleware that run before controller actions.
     */
    registerMiddleware(middleware: MiddlewareMetadata): void {

        // if its an error handler then register it with proper signature in express
        if ((middleware.instance as ExpressErrorMiddlewareInterface).error) {
            this.express.use(function (error: any, request: any, response: any, next: (err?: any) => any) {
                (middleware.instance as ExpressErrorMiddlewareInterface).error(error, request, response, next);
            });
            return;
        }

        // if its a regular middleware then register it as express middleware
        if ((middleware.instance as ExpressMiddlewareInterface).use) {
            this.express.use((request: any, response: any, next: (err: any) => any) => {
                try {
                    const useResult = (middleware.instance as ExpressMiddlewareInterface).use(request, response, next);
                    if (isPromiseLike(useResult)) {
                        useResult.catch((error: any) => {
                            this.handleError(error, undefined, {request, response, next});
                            return error;
                        });
                    }

                } catch (error) {
                    this.handleError(error, undefined, {request, response, next});
                }
            });
        }
    }

    /**
     * Registers action in the driver.
     */
    registerAction(actionMetadata: ActionMetadata, executeCallback: (options: Action) => any): void {

        // middlewares required for this action
        const defaultMiddlewares: any[] = [];

        if (actionMetadata.isBodyUsed) {
            if (actionMetadata.isJsonTyped) {
                defaultMiddlewares.push(this.loadBodyParser().json(actionMetadata.bodyExtraOptions));
            } else {
                defaultMiddlewares.push(this.loadBodyParser().text(actionMetadata.bodyExtraOptions));
            }
        }

        if (actionMetadata.isAuthorizedUsed) {
            defaultMiddlewares.push((request: any, response: any, next: Function) => {
                if (!this.authorizationChecker)
                    throw new AuthorizationCheckerNotDefinedError();

                const action: Action = { request, response, next };
                try {
                    const checkResult = this.authorizationChecker(action, actionMetadata.authorizedRoles);

                    const handleError = (result: any) => {
                        if (!result) {
                            let error = actionMetadata.authorizedRoles.length === 0 ? new AuthorizationRequiredError(action) : new AccessDeniedError(action);
                            this.handleError(error, actionMetadata, action);
                        } else {
                            next();
                        }
                    };

                    if (isPromiseLike(checkResult)) {
                        checkResult
                            .then(result => handleError(result))
                            .catch(error => this.handleError(error, actionMetadata, action));
                    } else {
                        handleError(checkResult);
                    }
                } catch (error) {
                    this.handleError(error, actionMetadata, action);
                }
            });
        }

        if (actionMetadata.isFileUsed || actionMetadata.isFilesUsed) {
            const multer = this.loadMulter();
            actionMetadata.params
                .filter(param => param.type === "file")
                .forEach(param => {
                    defaultMiddlewares.push(multer(param.extraOptions).single(param.name));
                });
            actionMetadata.params
                .filter(param => param.type === "files")
                .forEach(param => {
                    defaultMiddlewares.push(multer(param.extraOptions).array(param.name));
                });
        }

        // user used middlewares
        const uses = [...actionMetadata.controllerMetadata.uses, ...actionMetadata.uses];
        const beforeMiddlewares = this.prepareMiddlewares(uses.filter(use => !use.afterAction));
        const afterMiddlewares = this.prepareMiddlewares(uses.filter(use => use.afterAction));

        // prepare route and route handler function
        const route = ActionMetadata.appendBaseRoute(this.routePrefix, actionMetadata.fullRoute);
        const routeHandler = function routeHandler(request: any, response: any, next: Function) {
            // Express calls the "get" route automatically when we call the "head" route:
            // Reference: https://expressjs.com/en/4x/api.html#router.METHOD
            // This causes a double action execution on our side, which results in an unhandled rejection,
            // saying: "Can't set headers after they are sent".
            // The following line skips action processing when the request method does not match the action method.
            if (request.method.toLowerCase() !== actionMetadata.type)
                return next();

            return executeCallback({request, response, next});
        };

        // finally register action in express
        this.express[actionMetadata.type.toLowerCase()](...[
            route,
            ...beforeMiddlewares,
            ...defaultMiddlewares,
            routeHandler,
            ...afterMiddlewares
        ]);
    }

    /**
     * Registers all routes in the framework.
     */
    registerRoutes() {
    }

    /**
     * Gets param from the request.
     */
    getParamFromRequest(action: Action, param: ParamMetadata): any {
        const request: any = action.request;
        switch (param.type) {
            case "body":
                return request.body;

            case "body-param":
                return request.body[param.name];

            case "param":
                return request.params[param.name];

            case "params":
                return request.params;

            case "session":
                if (param.name)
                    return request.session[param.name];

                return request.session;

            case "state":
                throw new Error("@State decorators are not supported by express driver.");

            case "query":
                return request.query[param.name];

            case "queries":
                return request.query;

            case "header":
                return request.headers[param.name.toLowerCase()];

            case "headers":
                return request.headers;

            case "file":
                return request.file;

            case "files":
                return request.files;

            case "cookie":
                if (!request.headers.cookie) return;
                const cookies = cookie.parse(request.headers.cookie);
                return cookies[param.name];

            case "cookies":
                if (!request.headers.cookie) return {};
                return cookie.parse(request.headers.cookie);
        }
    }

    /**
     * Handles result of successfully executed controller action.
     */
    handleSuccess(result: any, action: ActionMetadata, options: Action): void {

        // if the action returned the response object itself, short-circuits
        if (result && result === options.response) {
            options.next();
            return;
        }

        // transform result if needed
        result = this.transformResult(result, action, options);

        // set http status code
        if (result === undefined && action.undefinedResultCode) {
            if (action.undefinedResultCode instanceof Function) {
                throw new (action.undefinedResultCode as any)(options);
            }
            options.response.status(action.undefinedResultCode);
        }
        else if (result === null) {
            if (action.nullResultCode) {
                if (action.nullResultCode instanceof Function) {
                    throw new (action.nullResultCode as any)(options);
                }
                options.response.status(action.nullResultCode);
            } else {
                options.response.status(204);
            }
        }
        else if (action.successHttpCode) {
            options.response.status(action.successHttpCode);
        }

        // apply http headers
        Object.keys(action.headers).forEach(name => {
            options.response.header(name, action.headers[name]);
        });

        if (action.redirect) { // if redirect is set then do it
            if (typeof result === "string") {
                options.response.redirect(result);
            } else if (result instanceof Object) {
                options.response.redirect(templateUrl(action.redirect, result));
            } else {
                options.response.redirect(action.redirect);
            }

            options.next();
        }
        else if (action.renderedTemplate) { // if template is set then render it
            const renderOptions = result && result instanceof Object ? result : {};

            options.response.render(action.renderedTemplate, renderOptions, (err: any, html: string) => {
                if (err && action.isJsonTyped) {
                    return options.next(err);

                } else if (err && !action.isJsonTyped) {
                    return options.next(err);

                } else if (html) {
                    options.response.send(html);
                }
                options.next();
            });
        }
        else if (result === undefined) { // throw NotFoundError on undefined response

            if (action.undefinedResultCode) {
                if (action.isJsonTyped) {
                    options.response.json();
                } else {
                    options.response.send();
                }

                options.response.body = null;

                options.next();

            } else {
                throw new NotFoundError();
            }
        }
        else if (result === null) { // send null response
            if (action.isJsonTyped) {
                options.response.json(null);
            } else {
                options.response.send(null);
            }

            options.response.body = null;

            options.next();
        }
        else if (result instanceof Buffer) { // check if it's binary data (Buffer)
            options.response.body = result;

            options.response.end(result, "binary");
        }
        else if (result instanceof Uint8Array) { // check if it's binary data (typed array)
            options.response.body = Buffer.from(result as any);

            options.response.end(Buffer.from(result as any), "binary");
        }
        else if (result.pipe instanceof Function) {
            result.pipe(options.response);
        }
        else { // send regular result
            if (action.isJsonTyped) {
                options.response.json(result);
            } else {
                options.response.send(result);
            }

            options.response.body = result;

            options.next();
        }
    }

    /**
     * Handles result of failed executed controller action.
     */
    handleError(error: any, action: ActionMetadata | undefined, options: Action): any {
        if (this.isDefaultErrorHandlingEnabled) {
            const response: any = options.response;

            // set http code
            // note that we can't use error instanceof HttpError properly anymore because of new typescript emit process
            if (error.httpCode) {
                response.status(error.httpCode);
            } else {
                response.status(500);
            }

            // apply http headers
            if (action) {
                Object.keys(action.headers).forEach(name => {
                    response.header(name, action.headers[name]);
                });
            }

            // send error content
            if (action && action.isJsonTyped) {
                response.json(this.processJsonError(error));
                response.body = this.processJsonError(error);
            } else {
                response.send(this.processTextError(error)); // todo: no need to do it because express by default does it
                response.body = this.processTextError(error);
            }
        }
        options.next(error);
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Creates middlewares from the given "use"-s.
     */
    protected prepareMiddlewares(uses: UseMetadata[]) {
        const middlewareFunctions: Function[] = [];
        uses.forEach(use => {
            if (use.middleware.prototype && use.middleware.prototype.use) { // if this is function instance of MiddlewareInterface
                middlewareFunctions.push((request: any, response: any, next: (err: any) => any) => {
                    try {
                        const useResult = (getFromContainer(use.middleware) as ExpressMiddlewareInterface).use(request, response, next);
                        if (isPromiseLike(useResult)) {
                            useResult.catch((error: any) => {
                                this.handleError(error, undefined, {request, response, next});
                                return error;
                            });
                        }

                        return useResult;
                    } catch (error) {
                        this.handleError(error, undefined, {request, response, next});
                    }
                });

            } else if (use.middleware.prototype && use.middleware.prototype.error) {  // if this is function instance of ErrorMiddlewareInterface
                middlewareFunctions.push(function (error: any, request: any, response: any, next: (err: any) => any) {
                    return (getFromContainer(use.middleware) as ExpressErrorMiddlewareInterface).error(error, request, response, next);
                });

            } else {
                middlewareFunctions.push(use.middleware);
            }
        });
        return middlewareFunctions;
    }

    /**
     * Dynamically loads express module.
     */
    protected loadExpress() {
        if (require) {
            if (!this.express) {
                try {
                    this.express = require("express")();
                } catch (e) {
                    throw new Error("express package was not found installed. Try to install it: npm install express --save");
                }
            }
        } else {
            throw new Error("Cannot load express. Try to install all required dependencies.");
        }
    }

    /**
     * Dynamically loads body-parser module.
     */
    protected loadBodyParser() {
        try {
            return require("body-parser");
        } catch (e) {
            throw new Error("body-parser package was not found installed. Try to install it: npm install body-parser --save");
        }
    }

    /**
     * Dynamically loads multer module.
     */
    protected loadMulter() {
        try {
            return require("multer");
        } catch (e) {
            throw new Error("multer package was not found installed. Try to install it: npm install multer --save");
        }
    }

}
