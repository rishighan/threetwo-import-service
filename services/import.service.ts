"use strict";
import { isNil, map } from "lodash";
import {
	Context,
	Service,
	ServiceBroker,
	ServiceSchema,
	Errors,
} from "moleculer";
import { DbMixin } from "../mixins/db.mixin";
import Comic from "../models/comic.model";
import { explodePath, walkFolder } from "../utils/file.utils";
import { convertXMLToJSON } from "../utils/xml.utils";
import https from "https";
import {
	IExtractComicBookCoverErrorResponse,
	IExtractedComicBookCoverFile,
	IExtractionOptions,
} from "threetwo-ui-typings";
import { unrarArchive } from "../utils/uncompression.utils";
import { extractCoverFromFile2 } from "../utils/uncompression.utils";
import { scrapeIssuesFromDOM } from "../utils/scraping.utils";
const ObjectId = require("mongoose").Types.ObjectId;
import fsExtra from "fs-extra";
const through2 = require("through2");
import klaw from "klaw";
import path from "path";
import { COMICS_DIRECTORY, USERDATA_DIRECTORY } from "../constants/directories";

export default class ImportService extends Service {
	public constructor(
		public broker: ServiceBroker,
		schema: ServiceSchema<{}> = { name: "import" }
	) {
		super(broker);
		this.parseServiceSchema(
			Service.mergeSchemas(
				{
					name: "import",
					mixins: [DbMixin("comics", Comic)],
					settings: {
						// Available fields in the responses
						fields: ["_id", "name", "quantity", "price"],

						// Validator for the `create` & `insert` actions.
						entityValidator: {
							name: "string|min:3",
							price: "number|positive",
						},
					},
					hooks: {},
					actions: {
						walkFolders: {
							rest: "POST /walkFolders",
							params: {
								basePathToWalk: "string",
							},
							async handler(
								ctx: Context<{ basePathToWalk: string }>
							) {
								return await walkFolder(
									ctx.params.basePathToWalk,
									[".cbz", ".cbr"]
								);
							},
						},
						convertXMLToJSON: {
							rest: "POST /convertXmlToJson",
							params: {},
							async handler(ctx: Context<{}>) {
								return convertXMLToJSON("lagos");
							},
						},
						newImport: {
							rest: "POST /newImport",
							params: {},
							async handler(
								ctx: Context<{
									extractionOptions?: any;
								}>
							) {
								// 1. Walk the Source folder
								klaw(path.resolve(COMICS_DIRECTORY))
									// 1.1 Filter on .cb* extensions
									.pipe(
										through2.obj(function (
											item,
											enc,
											next
										) {
											let fileExtension = path.extname(
												item.path
											);
											if (
												[
													".cbz",
													".cbr",
													".cb7",
												].includes(fileExtension)
											) {
												this.push(item);
											}

											next();
										})
									)
									// 1.2 Pipe filtered results to the next step
									.on("data", async (item) => {
										console.info(
											"Found a file at path: %s",
											item.path
										);
										let comicExists = await Comic.exists({
											"rawFileDetails.name": `${path.basename(
												item.path,
												path.extname(item.path)
											)}`,
										});
										if (!comicExists) {
											// 2. Send the extraction job to the queue
											await broker.call(
												"libraryqueue.enqueue",
												{
													fileObject: {
														filePath: item.path,
														size: item.stats.size,
													},
												}
											);
										} else {
											console.log(
												"Comic already exists in the library."
											);
										}
									})
									.on("end", () => {
										console.log("Import process complete.");
									});
							},
						},
						nicefyPath: {
							rest: "POST /nicefyPath",
							params: {},
							async handler(
								ctx: Context<{
									filePath: string;
								}>
							) {
								return explodePath(ctx.params.filePath);
							},
						},
						processAndImportToDB: {
							rest: "POST /processAndImportToDB",

							params: {},
							async handler(
								ctx: Context<{
									extractionOptions: any;
									walkedFolders: {
										name: string;
										path: string;
										extension: string;
										containedIn: string;
										fileSize: number;
										isFile: boolean;
										isLink: boolean;
									};
								}>
							) {
								try {
									const { extractionOptions, walkedFolders } =
										ctx.params;
									let comicExists = await Comic.exists({
										"rawFileDetails.name": `${walkedFolders.name}`,
									});
									// rough flow of import process
									// 1. Walk folder
									// 2. For each folder, call extract function
									// 3. For each successful extraction, run dbImport

									if (!comicExists) {
										// 1. Extract cover and cover metadata
										let comicBookCoverMetadata:
											| IExtractedComicBookCoverFile
											| IExtractComicBookCoverErrorResponse
											| IExtractedComicBookCoverFile[] = await extractCoverFromFile2(
											extractionOptions,
										);

										// 2. Add to mongo
										const dbImportResult =
											await this.broker.call(
												"import.rawImportToDB",
												{
													importStatus: {
														isImported: true,
														tagged: false,
														matchedResult: {
															score: "0",
														},
													},
													rawFileDetails:
														comicBookCoverMetadata,
													sourcedMetadata: {
														comicvine: {},
													},
												},
												{}
											);

										return {
											comicBookCoverMetadata,
											dbImportResult,
										};
									} else {
										console.info(
											`Comic: \"${walkedFolders.name}\" already exists in the database`
										);
									}
								} catch (error) {
									console.error(
										"Error importing comic books",
										error
									);
								}
							},
						},
						rawImportToDB: {
							rest: "POST /rawImportToDB",
							params: {},
							async handler(
								ctx: Context<{
									sourcedMetadata: {
										comicvine: {
											volume: { api_detail_url: string };
											volumeInformation: {};
										};
									};
									rawFileDetails: {
										name: string;
									};
								}>
							) {
								let volumeDetails;
								const comicMetadata = ctx.params;
								if (
									comicMetadata.sourcedMetadata.comicvine &&
									!isNil(
										comicMetadata.sourcedMetadata.comicvine
											.volume
									)
								) {
									volumeDetails =
										await this.getComicVineVolumeMetadata(
											comicMetadata.sourcedMetadata
												.comicvine.volume.api_detail_url
										);
									comicMetadata.sourcedMetadata.comicvine.volumeInformation =
										volumeDetails;
								}
								return new Promise(async (resolve, reject) => {
									Comic.create(ctx.params, (error, data) => {
										if (data) {
											resolve(data);
										} else if (error) {
											throw new Errors.MoleculerError(
												"Failed to import comic book",
												400,
												"IMS_FAILED_COMIC_BOOK_IMPORT",
												data
											);
										}
									});
								});
							},
						},
						applyComicVineMetadata: {
							rest: "POST /applyComicVineMetadata",
							params: {},
							async handler(
								ctx: Context<{
									match: {
										volume: { api_detail_url: string };
										volumeInformation: object;
									};
									comicObjectId: string;
								}>
							) {
								// 1. Find mongo object by id
								// 2. Import payload into sourcedMetadata.comicvine
								const comicObjectId = new ObjectId(
									ctx.params.comicObjectId
								);
								const matchedResult = ctx.params.match;
								let volumeDetailsPromise;
								if (!isNil(matchedResult.volume)) {
									volumeDetailsPromise =
										this.getComicVineVolumeMetadata(
											matchedResult.volume.api_detail_url
										);
								}
								return new Promise(async (resolve, reject) => {
									const volumeDetails =
										await volumeDetailsPromise;
									matchedResult.volumeInformation =
										volumeDetails;
									Comic.findByIdAndUpdate(
										comicObjectId,
										{
											sourcedMetadata: {
												comicvine: matchedResult,
											},
										},
										{ new: true },
										(err, result) => {
											if (err) {
												console.info(err);
												reject(err);
											} else {
												// 3. Fetch and append volume information
												resolve(result);
											}
										}
									);
								});
							},
						},
						applyAirDCPPDownloadMetadata: {
							rest: "POST /applyAirDCPPDownloadMetadata",
							params: {},
							async handler(
								ctx: Context<{
									comicObjectId: string;
									resultId: string;
									bundleId: string;
									directoryIds: [];
									searchInstanceId: string;
								}>
							) {
								const comicObjectId = new ObjectId(
									ctx.params.comicObjectId
								);
								return new Promise((resolve, reject) => {
									Comic.findByIdAndUpdate(
										comicObjectId,
										{
											$push: {
												"acquisition.directconnect": {
													resultId:
														ctx.params.resultId,
													bundleId:
														ctx.params.bundleId,
													directoryIds:
														ctx.params.directoryIds,
													searchInstanceId:
														ctx.params
															.searchInstanceId,
												},
											},
										},
										{ new: true, safe: true, upsert: true },
										(err, result) => {
											if (err) {
												reject(err);
											} else {
												resolve(result);
											}
										}
									);
								});
							},
						},

						getComicBooks: {
							rest: "POST /getComicBooks",
							params: {},
							async handler(
								ctx: Context<{ paginationOptions: object }>
							) {
								return await Comic.paginate(
									{},
									ctx.params.paginationOptions
								);
							},
						},
						getComicBookById: {
							rest: "POST /getComicBookById",
							params: { id: "string" },
							async handler(ctx: Context<{ id: string }>) {
								return await Comic.findById(ctx.params.id);
							},
						},
						getComicBookGroups: {
							rest: "GET /getComicBookGroups",
							params: {},
							async handler(ctx: Context<{}>) {
								let volumesMetadata = [];
								// 1. get volumes with issues mapped where issue count > 2
								const volumes = await Comic.aggregate([
									{
										$group: {
											_id: "$sourcedMetadata.comicvine.volume.id",
											volumeURI: {
												$last: "$sourcedMetadata.comicvine.volume.api_detail_url",
											},
											count: { $sum: 1 },
										},
									},
									{
										$match: {
											count: { $gte: 2 },
										},
									},
									{ $sort: { updatedAt: -1 } },
									{ $skip: 0 },
									{ $limit: 5 },
								]);
								// 2. Map over the aggregation result and get volume metadata from CV
								// 2a. Make a call to comicvine-service
								volumesMetadata = map(
									volumes,
									async (volume) => {
										if (!isNil(volume.volumeURI)) {
											return await ctx.call(
												"comicvine.getVolumes",
												{
													volumeURI: volume.volumeURI,
													data: {
														format: "json",
														fieldList:
															"id,name,deck,api_detail_url",
														limit: "1",
														offset: "0",
													},
												}
											);
										}
									}
								);

								return Promise.all(volumesMetadata);
							},
						},
						flushDB: {
							rest: "POST /flushDB",
							params: {},
							async handler(ctx: Context<{}>) {
								return await Comic.collection
									.drop()
									.then((data) => {
										console.info(data);
										const foo = fsExtra.emptyDirSync(
											path.resolve(
												`${USERDATA_DIRECTORY}/covers`
											)
										);
										const foo2 = fsExtra.emptyDirSync(
											path.resolve(
												`${USERDATA_DIRECTORY}/expanded`
											)
										);
										return { data, foo, foo2 };
									})
									.catch((error) => error);
							},
						},
						scrapeIssueNamesFromDOM: {
							rest: "POST /scrapeIssueNamesFromDOM",
							params: {},
							async handler(ctx: Context<{ html: string }>) {
								return scrapeIssuesFromDOM(ctx.params.html);
							},
						},
						unrarArchive: {
							rest: "POST /unrarArchive",
							params: {},
							timeout: 10000,
							async handler(
								ctx: Context<{
									filePath: string;
									options: IExtractionOptions;
								}>
							) {
								return await unrarArchive(
									ctx.params.filePath,
									ctx.params.options
								);
							},
						},
					},
					methods: {
						getComicVineVolumeMetadata: (apiDetailURL) =>
							new Promise((resolve, reject) => {
								const options = {
									headers: {
										"User-Agent": "ThreeTwo",
									},
								};
								return https
									.get(
										`${apiDetailURL}?api_key=${process.env.COMICVINE_API_KEY}&format=json&limit=1&offset=0&field_list=id,name,description,image,first_issue,last_issue,publisher,count_of_issues,character_credits,person_credits,aliases`,
										options,
										(resp) => {
											let data = "";
											resp.on("data", (chunk) => {
												data += chunk;
											});

											resp.on("end", () => {
												console.info(
													data,
													"HERE, BITCHES< HERE"
												);
												const volumeInformation =
													JSON.parse(data);
												resolve(
													volumeInformation.results
												);
											});
										}
									)
									.on("error", (err) => {
										console.info("Error: " + err.message);
										reject(err);
									});
							}),
					},
				},
				schema
			)
		);
	}
}
