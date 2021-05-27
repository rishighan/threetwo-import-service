import { IncomingMessage } from "http";
import fs from "fs";
import path from "path";
import { Service, ServiceBroker, Context } from "moleculer";
import ApiGateway from "moleculer-web";
import { getCovers, extractArchive } from "../utils/uncompression.utils";
import { map, flatten } from "lodash";
import JSONStream from "JSONStream";
const IO = require("socket.io")();
const ss = require("socket.io-stream");
const JsonStreamStringify = require("json-stream-stringify");
import axios from "axios";
const { Writable, Readable } = require("stream");

export default class ApiService extends Service {
	public constructor(broker: ServiceBroker) {
		super(broker);
		// @ts-ignore
		this.parseServiceSchema({
			name: "api",
			mixins: [ApiGateway],
			// More info about settings: https://moleculer.services/docs/0.14/moleculer-web.html
			settings: {
				port: process.env.PORT || 3000,

				routes: [
					{
						path: "/api",
						whitelist: [
							// Access to any actions in all services under "/api" URL
							"**",
						],
						use: [],
						mergeParams: true,
						autoAliases: true,

						aliases: {
							async "POST getComicCovers"(req, res) {
								const { extractionOptions, walkedFolders } =
									req.body;
							},
						},

						// Calling options. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Calling-options
						callingOptions: {},

						bodyParsers: {
							json: {
								strict: false,
								limit: "1MB",
							},
							urlencoded: {
								extended: true,
								limit: "1MB",
							},
						},

						// Mapping policy setting. More info: https://moleculer.services/docs/0.14/moleculer-web.html#Mapping-policy
						mappingPolicy: "all", // Available values: "all", "restrict"

						// Enable/disable logging
						logging: true,
					},
				],
				// Do not log client side errors (does not log an error response when the error.code is 400<=X<500)
				log4XXResponses: false,
				// Logging the request parameters. Set to any log level to enable it. E.g. "info"
				logRequestParams: null,
				// Logging the response data. Set to any log level to enable it. E.g. "info"
				logResponseData: null,
				// Serve assets from "public" folder
				assets: {
					folder: "public",
					// Options to `server-static` module
					options: {},
				},
			},

			methods: {},
			events: {
				"**"(payload, sender, event) {
					if (this.io)
						this.io.emit("event", {
							sender,
							event,
							payload,
						});
				},
			},
			started(): any {
				// Create a Socket.IO instance, passing it our server
				this.io = IO.listen(this.server);

				// Add a connect listener
				this.io.on("connection", (client) => {
					this.logger.info("Client connected via websocket!");

					client.on(
						"call",
						async ({ action, params, opts }, done) => {
							this.logger.info(
								"Received request from client! Action:",
								action,
								", Params:",
								params
							);
							const { extractionOptions, walkedFolders } = params;
							const stream = ss.createStream();
							switch (extractionOptions.extractionMode) {
								case "bulk":
									map(walkedFolders, async (folder, idx) => {
										let foo = await extractArchive(
											extractionOptions,
											folder
										);

										let fo = new JsonStreamStringify({
											foo,
										});

										client.emit("comicBookCoverMetadata", {
											data: foo,
											status: "Done!",
										});
									});
								// res.end();

								case "single":
									return await extractArchive(
										extractionOptions,
										walkedFolders[0]
									);
								default:
									console.log(
										"Unknown extraction mode selected."
									);
									return {
										message:
											"Unknown extraction mode selected.",
										errorCode: "90",
										data: `${extractionOptions}`,
									};
							}

							// this.broker
							// 	.call("import." + action, params, opts)
							// 	.then((resp) => {
							// 		// client.emit("comicBookCoverMetadata", resp);
							// 	})
							// 	.catch((err) => this.logger.error(err));
						}
					);

					client.on("disconnect", () => {
						this.logger.info("Client disconnected");
					});
				});
			},
		});
	}
}
