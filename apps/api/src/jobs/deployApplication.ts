import { parentPort } from 'node:worker_threads';
import crypto from 'crypto';
import fs from 'fs/promises';
import yaml from 'js-yaml';

import {
	copyBaseConfigurationFiles,
	makeLabelForSimpleDockerfile,
	makeLabelForStandaloneApplication,
	saveBuildLog,
	saveDockerRegistryCredentials,
	setDefaultConfiguration
} from '../lib/buildPacks/common';
import {
	createDirectories,
	decrypt,
	defaultComposeConfiguration,
	getDomain,
	prisma,
	decryptApplication,
	isDev,
	pushToRegistry,
	executeCommand,
	generateSecrets
} from '../lib/common';
import * as importers from '../lib/importers';
import * as buildpacks from '../lib/buildPacks';

// --- zero-downtime deploy support ---
// The active container per application is tracked in a small JSON file on the
// persistent db volume, so the Traefik config generator can point the service
// at the replacement container as soon as it is ready.
const ZD_ACTIVE_FILE = '/app/db/zd-active.json';
function zdSleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function setZdActiveContainer(applicationId: string, containerName: string) {
	let map: Record<string, string> = {};
	try {
		map = JSON.parse(await fs.readFile(ZD_ACTIVE_FILE, 'utf8'));
	} catch {
		map = {};
	}
	if (!map || typeof map !== 'object') map = {};
	map[applicationId] = containerName;
	await fs.writeFile(`${ZD_ACTIVE_FILE}.tmp`, JSON.stringify(map));
	await fs.rename(`${ZD_ACTIVE_FILE}.tmp`, ZD_ACTIVE_FILE);
}
async function waitForAppReady({
	dockerId,
	network,
	containerName,
	port,
	httpTimeoutMs = 120000,
	runningGraceMs = 20000
}: {
	dockerId: string;
	network: string;
	containerName: string;
	port: number | string;
	httpTimeoutMs?: number;
	runningGraceMs?: number;
}) {
	try {
		await executeCommand({
			dockerId,
			command: `docker network connect ${network} coolify`
		});
	} catch {
		//
	}
	const deadline = Date.now() + httpTimeoutMs;
	let runningSince: number | null = null;
	let seenRestarts: string | null = null;
	while (Date.now() < deadline) {
		try {
			const { stdout } = await executeCommand({
				dockerId,
				command: `curl -s -o /dev/null -w %{http_code} --max-time 3 http://${containerName}:${port}/`
			});
			const code = (stdout || '').trim();
			if (/^[1-5][0-9][0-9]$/.test(code)) {
				return true;
			}
		} catch {
			//
		}
		try {
			const { stdout } = await executeCommand({
				dockerId,
				command: `docker inspect -f "{{.State.Running}} {{.RestartCount}}" ${containerName}`
			});
			const parts = (stdout || '').trim().split(' ');
			const running = parts[0];
			const restarts = parts[1];
			if (running === 'true') {
				if (seenRestarts === null || restarts !== seenRestarts) {
					seenRestarts = restarts;
					runningSince = Date.now();
				} else if (runningSince === null) {
					runningSince = Date.now();
				}
			} else {
				runningSince = null;
				seenRestarts = null;
			}
		} catch {
			runningSince = null;
			seenRestarts = null;
		}
		if (runningSince !== null && Date.now() - runningSince >= runningGraceMs) {
			return true;
		}
		await zdSleep(1000);
	}
	return false;
}


(async () => {
	if (parentPort) {
		parentPort.on('message', async (message) => {
			if (message === 'error') throw new Error('oops');
			if (message === 'cancel') {
				parentPort.postMessage('cancelled');
				await prisma.$disconnect();
				process.exit(0);
			}
		});
		const pThrottle = await import('p-throttle');
		const throttle = pThrottle.default({
			limit: 1,
			interval: 2000
		});

		const th = throttle(async () => {
			try {
				const queuedBuilds = await prisma.build.findMany({
					where: { status: { in: ['queued', 'running'] } },
					orderBy: { createdAt: 'asc' }
				});
				const { concurrentBuilds } = await prisma.setting.findFirst({});
				if (queuedBuilds.length > 0) {
					parentPort.postMessage({ deploying: true });
					const concurrency = concurrentBuilds;
					const pAll = await import('p-all');
					const actions = [];

					for (const queueBuild of queuedBuilds) {
						actions.push(async () => {
							let application = await prisma.application.findUnique({
								where: { id: queueBuild.applicationId },
								include: {
									dockerRegistry: true,
									destinationDocker: true,
									gitSource: { include: { githubApp: true, gitlabApp: true } },
									persistentStorage: true,
									secrets: true,
									settings: true,
									teams: true
								}
							});
							if (!application) {
								await prisma.build.update({
									where: { id: queueBuild.id },
									data: {
										status: 'failed'
									}
								});
								throw new Error('Application not found');
							}
							let {
								id: buildId,
								type,
								gitSourceId,
								sourceBranch = null,
								pullmergeRequestId = null,
								previewApplicationId = null,
								forceRebuild,
								sourceRepository = null
							} = queueBuild;
							application = decryptApplication(application);

							if (!gitSourceId && application.simpleDockerfile) {
								const {
									id: applicationId,
									destinationDocker,
									destinationDockerId,
									secrets,
									port,
									persistentStorage,
									exposePort,
									simpleDockerfile,
									dockerRegistry
								} = application;
								const { workdir } = await createDirectories({ repository: applicationId, buildId });
								try {
									if (queueBuild.status === 'running') {
										await saveBuildLog({
											line: 'Building halted, restarting...',
											buildId,
											applicationId: application.id
										});
									}
									const volumes =
										persistentStorage?.map((storage) => {
											if (storage.oldPath) {
												return `${applicationId}${storage.path
													.replace(/\//gi, '-')
													.replace('-app', '')}:${storage.path}`;
											}
											if (storage.hostPath) {
												return `${storage.hostPath}:${storage.path}`;
											}
											return `${applicationId}${storage.path.replace(/\//gi, '-')}:${storage.path}`;
										}) || [];

									if (destinationDockerId) {
										await prisma.build.update({
											where: { id: buildId },
											data: { status: 'running' }
										});
										try {
											const { stdout: containers } = await executeCommand({
												dockerId: destinationDockerId,
												command: `docker ps -a --filter 'label=com.docker.compose.service=${applicationId}' --format {{.ID}}`
											});
											if (containers) {
												const containerArray = containers.split('\n');
												if (containerArray.length > 0) {
													for (const container of containerArray) {
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker stop -t 0 ${container}`
														});
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker rm --force ${container}`
														});
													}
												}
											}
										} catch (error) {
											//
										}
										let envs = [];
										if (secrets.length > 0) {
											envs = [
												...envs,
												...generateSecrets(secrets, pullmergeRequestId, false, port)
											];
										}
										await fs.writeFile(`${workdir}/Dockerfile`, simpleDockerfile);
										if (dockerRegistry) {
											const { url, username, password } = dockerRegistry;
											await saveDockerRegistryCredentials({ url, username, password, workdir });
										}

										const labels = makeLabelForSimpleDockerfile({
											applicationId,
											type,
											port: exposePort ? `${exposePort}:${port}` : port
										});
										try {
											const composeVolumes = volumes
												.filter((v) => {
													if (
														!v.startsWith('.') &&
														!v.startsWith('..') &&
														!v.startsWith('/') &&
														!v.startsWith('~')
													) {
														return v;
													}
												})
												.map((volume) => {
													return {
														[`${volume.split(':')[0]}`]: {
															name: volume.split(':')[0]
														}
													};
												});
											const composeFile = {
												version: '3.8',
												services: {
													[applicationId]: {
														build: {
															context: workdir
														},
														image: `${applicationId}:${buildId}`,
														container_name: applicationId,
														volumes,
														labels,
														environment: envs,
														depends_on: [],
														expose: [port],
														...(exposePort ? { ports: [`${exposePort}:${port}`] } : {}),
														...defaultComposeConfiguration(destinationDocker.network)
													}
												},
												networks: {
													[destinationDocker.network]: {
														external: true
													}
												},
												volumes: Object.assign({}, ...composeVolumes)
											};
											await fs.writeFile(`${workdir}/docker-compose.yml`, yaml.dump(composeFile));
											await executeCommand({
												debug: true,
												dockerId: destinationDocker.id,
												command: `docker compose --project-directory ${workdir} -f ${workdir}/docker-compose.yml up -d`
											});
											await saveBuildLog({ line: 'Deployed 🎉', buildId, applicationId });
										} catch (error) {
											await saveBuildLog({ line: error, buildId, applicationId });
											const foundBuild = await prisma.build.findUnique({ where: { id: buildId } });
											if (foundBuild) {
												await prisma.build.update({
													where: { id: buildId },
													data: {
														status: 'failed'
													}
												});
											}
											throw new Error(error);
										}
									}
								} catch (error) {
									const foundBuild = await prisma.build.findUnique({ where: { id: buildId } });
									if (foundBuild) {
										await prisma.build.update({
											where: { id: buildId },
											data: {
												status: 'failed'
											}
										});
									}
									if (error !== 1) {
										await saveBuildLog({ line: error, buildId, applicationId: application.id });
									}
									if (error instanceof Error) {
										await saveBuildLog({
											line: error.message,
											buildId,
											applicationId: application.id
										});
									}
									if (!isDev) await fs.rm(workdir, { recursive: true, force: true });
									return;
								}
								try {
									if (application.dockerRegistryImageName) {
										const customTag = application.dockerRegistryImageName.split(':')[1] || buildId;
										const imageName = application.dockerRegistryImageName.split(':')[0];
										await saveBuildLog({
											line: `Pushing ${imageName}:${customTag} to Docker Registry... It could take a while...`,
											buildId,
											applicationId: application.id
										});
										await pushToRegistry(application, workdir, buildId, imageName, customTag);
										await saveBuildLog({ line: 'Success', buildId, applicationId: application.id });
									}
								} catch (error) {
									if (error.stdout) {
										await saveBuildLog({ line: error.stdout, buildId, applicationId });
									}
									if (error.stderr) {
										await saveBuildLog({ line: error.stderr, buildId, applicationId });
									}
								} finally {
									if (!isDev) await fs.rm(workdir, { recursive: true, force: true });
									await prisma.build.update({
										where: { id: buildId },
										data: { status: 'success' }
									});
								}
								return;
							}

							const originalApplicationId = application.id;
							const {
								id: applicationId,
								name,
								destinationDocker,
								destinationDockerId,
								gitSource,
								configHash,
								fqdn,
								projectId,
								secrets,
								phpModules,
								settings,
								persistentStorage,
								pythonWSGI,
								pythonModule,
								pythonVariable,
								denoOptions,
								exposePort,
								baseImage,
								baseBuildImage,
								deploymentType,
								gitCommitHash,
								dockerRegistry
							} = application;

							let {
								branch,
								repository,
								buildPack,
								port,
								installCommand,
								buildCommand,
								startCommand,
								baseDirectory,
								publishDirectory,
								dockerFileLocation,
								dockerComposeFileLocation,
								dockerComposeConfiguration,
								denoMainFile
							} = application;

							let imageId = applicationId;
							let domain = getDomain(fqdn);

							let location = null;

							let tag = null;
							let customTag = null;
							let imageName = null;
							let pullAuthoritative = false;

							let imageFoundLocally = false;
							let imageFoundRemotely = false;

							if (pullmergeRequestId) {
								const previewApplications = await prisma.previewApplication.findMany({
									where: { applicationId: originalApplicationId, pullmergeRequestId }
								});
								if (previewApplications.length > 0) {
									previewApplicationId = previewApplications[0].id;
								}
								// Previews, we need to get the source branch and set subdomain
								branch = sourceBranch;
								domain = `${pullmergeRequestId}.${domain}`;
								imageId = `${applicationId}-${pullmergeRequestId}`;
								repository = sourceRepository || repository;
							}
							const { workdir, repodir } = await createDirectories({ repository, buildId });
							try {
								if (queueBuild.status === 'running') {
									await saveBuildLog({
										line: 'Building halted, restarting...',
										buildId,
										applicationId: application.id
									});
								}

								const currentHash = crypto
									.createHash('sha256')
									.update(
										JSON.stringify({
											pythonWSGI,
											pythonModule,
											pythonVariable,
											deploymentType,
											denoOptions,
											baseImage,
											baseBuildImage,
											buildPack,
											port,
											exposePort,
											installCommand,
											buildCommand,
											startCommand,
											secrets,
											branch,
											repository,
											fqdn
										})
									)
									.digest('hex');
								const { debug } = settings;
								if (!debug) {
									await saveBuildLog({
										line: `Debug logging is disabled. Enable it above if necessary!`,
										buildId,
										applicationId
									});
								}
								const volumes =
									persistentStorage?.map((storage) => {
										if (storage.oldPath) {
											return `${applicationId}${storage.path
												.replace(/\//gi, '-')
												.replace('-app', '')}:${storage.path}`;
										}
										if (storage.hostPath) {
											return `${storage.hostPath}:${storage.path}`;
										}
										return `${applicationId}${storage.path.replace(/\//gi, '-')}:${storage.path}`;
									}) || [];

								try {
									dockerComposeConfiguration = JSON.parse(dockerComposeConfiguration);
								} catch (error) {}
								let deployNeeded = true;
								let destinationType;

								if (destinationDockerId) {
									destinationType = 'docker';
								}
								if (destinationType === 'docker') {
									await prisma.build.update({
										where: { id: buildId },
										data: { status: 'running' }
									});

									const configuration = await setDefaultConfiguration(application);

									buildPack = configuration.buildPack;
									port = configuration.port;
									installCommand = configuration.installCommand;
									startCommand = configuration.startCommand;
									buildCommand = configuration.buildCommand;
									publishDirectory = configuration.publishDirectory || '';
									baseDirectory = configuration.baseDirectory || '';
									dockerFileLocation = configuration.dockerFileLocation;
									dockerComposeFileLocation = configuration.dockerComposeFileLocation;
									denoMainFile = configuration.denoMainFile;
									const commit = await importers[gitSource.type]({
										applicationId,
										debug,
										workdir,
										repodir,
										githubAppId: gitSource.githubApp?.id,
										gitlabAppId: gitSource.gitlabApp?.id,
										customPort: gitSource.customPort,
										customUser: gitSource.customUser,
										gitCommitHash,
										configuration,
										repository,
										branch,
										buildId,
										apiUrl: gitSource.apiUrl,
										htmlUrl: gitSource.htmlUrl,
										projectId,
										deployKeyId: gitSource.gitlabApp?.deployKeyId || null,
										privateSshKey: decrypt(gitSource.gitlabApp?.privateSshKey) || null,
										forPublic: gitSource.forPublic
									});
									if (!commit) {
										throw new Error('No commit found?');
									}
									tag = commit.slice(0, 7);
									if (pullmergeRequestId) {
										tag = `${commit.slice(0, 7)}-${pullmergeRequestId}`;
									}
									if (application.dockerRegistryImageName) {
										const ref = application.dockerRegistryImageName;
										const lastColon = ref.lastIndexOf(':');
										const lastSlash = ref.lastIndexOf('/');
										if (lastColon > lastSlash) {
											imageName = ref.slice(0, lastColon);
											customTag = ref.slice(lastColon + 1) || tag;
										} else {
											imageName = ref;
											customTag = tag;
										}
										pullAuthoritative = true;
									} else {
										customTag = tag;
										imageName = applicationId;
									}

									if (pullmergeRequestId) {
										customTag = `${customTag}-${pullmergeRequestId}`;
									}

									try {
										await prisma.build.update({ where: { id: buildId }, data: { commit } });
									} catch (err) {}

									if (!pullmergeRequestId) {
										if (configHash !== currentHash) {
											deployNeeded = true;
											if (configHash) {
												await saveBuildLog({
													line: 'Configuration changed',
													buildId,
													applicationId
												});
											}
										} else {
											deployNeeded = false;
										}
									} else {
										deployNeeded = true;
									}

									try {
										await executeCommand({
											dockerId: destinationDocker.id,
											command: `docker image inspect ${applicationId}:${tag}`
										});
										imageFoundLocally = true;
									} catch (error) {
										//
									}
									if (dockerRegistry) {
										const { url, username, password } = dockerRegistry;
										location = await saveDockerRegistryCredentials({
											url,
											username,
											password,
											workdir
										});
									}

									if (pullAuthoritative && forceRebuild) {
										try {
											await executeCommand({
												dockerId: destinationDocker.id,
												command: `docker rmi ${imageName}:${customTag}`
											});
										} catch (error) {
											//
										}
									}
									try {
										await executeCommand({
											dockerId: destinationDocker.id,
											command: `docker ${location ? `--config ${location}` : ''} pull ${imageName}:${customTag}`
										});
										imageFoundRemotely = true;
									} catch (error) {
										if (pullAuthoritative) {
											await saveBuildLog({
												line: `Registry image ${imageName}:${customTag} could not be pulled. Refusing to build on the host; build and push it from CI or fix the registry credentials.`,
												buildId,
												applicationId
											});
											throw new Error(`Could not pull ${imageName}:${customTag} from the registry.`);
										}
									}
									let imageFound = `${applicationId}:${tag}`;
									if (imageFoundRemotely) {
										imageFound = `${imageName}:${customTag}`;
									}
									await copyBaseConfigurationFiles(
										buildPack,
										workdir,
										buildId,
										applicationId,
										baseImage
									);
									const labels = makeLabelForStandaloneApplication({
										applicationId,
										fqdn,
										name,
										type,
										pullmergeRequestId,
										buildPack,
										repository,
										branch,
										projectId,
										port: exposePort ? `${exposePort}:${port}` : port,
										commit,
										installCommand,
										buildCommand,
										startCommand,
										baseDirectory,
										publishDirectory
									});
									if (pullAuthoritative) {
										deployNeeded = false;
									} else if (forceRebuild) {
										deployNeeded = true;
									}
									if (!pullAuthoritative && ((!imageFoundLocally && !imageFoundRemotely) || deployNeeded)) {
										if (buildpacks[buildPack])
											await buildpacks[buildPack]({
												dockerId: destinationDocker.id,
												network: destinationDocker.network,
												buildId,
												applicationId,
												domain,
												name,
												type,
												volumes,
												labels,
												pullmergeRequestId,
												buildPack,
												repository,
												branch,
												projectId,
												publishDirectory,
												debug,
												commit,
												tag,
												workdir,
												port: exposePort ? `${exposePort}:${port}` : port,
												installCommand,
												buildCommand,
												startCommand,
												baseDirectory,
												secrets,
												phpModules,
												pythonWSGI,
												pythonModule,
												pythonVariable,
												dockerFileLocation,
												dockerComposeConfiguration,
												dockerComposeFileLocation,
												denoMainFile,
												denoOptions,
												baseImage,
												baseBuildImage,
												deploymentType,
												forceRebuild
											});
										else {
											await saveBuildLog({
												line: `Build pack ${buildPack} not found`,
												buildId,
												applicationId
											});
											throw new Error(`Build pack ${buildPack} not found.`);
										}
									} else {
										if (imageFoundRemotely || deployNeeded) {
											await saveBuildLog({
												line: `Container image ${imageFound} found in Docker Registry - reuising it`,
												buildId,
												applicationId
											});
										} else {
											if (imageFoundLocally || deployNeeded) {
												await saveBuildLog({
													line: `Container image ${imageFound} found locally - reuising it`,
													buildId,
													applicationId
												});
											}
										}
									}

									if (buildPack === 'compose') {
										const fileYaml = `${workdir}${baseDirectory}${dockerComposeFileLocation}`;
										try {
											const { stdout: containers } = await executeCommand({
												dockerId: destinationDockerId,
												command: `docker ps -a --filter 'label=coolify.applicationId=${applicationId}' --format {{.ID}}`
											});
											if (containers) {
												const containerArray = containers.split('\n');
												if (containerArray.length > 0) {
													for (const container of containerArray) {
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker stop -t 0 ${container}`
														});
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker rm --force ${container}`
														});
													}
												}
											}
										} catch (error) {
											//
										}
										try {
											await executeCommand({
												debug,
												buildId,
												applicationId,
												dockerId: destinationDocker.id,
												command: `docker compose --project-directory ${workdir} -f ${fileYaml} up -d`
											});
											await saveBuildLog({ line: 'Deployed 🎉', buildId, applicationId });
											await prisma.build.update({
												where: { id: buildId },
												data: { status: 'success' }
											});
											await prisma.application.update({
												where: { id: applicationId },
												data: { configHash: currentHash }
											});
										} catch (error) {
											await saveBuildLog({ line: error, buildId, applicationId });
											const foundBuild = await prisma.build.findUnique({ where: { id: buildId } });
											if (foundBuild) {
												await prisma.build.update({
													where: { id: buildId },
													data: {
														status: 'failed'
													}
												});
											}
											throw new Error(error);
										}
									} else {
										const isPreview = !!pullmergeRequestId;
										const newContainerName = isPreview ? imageId : `${imageId}-${buildId}`;
										let oldContainerNames: string[] = [];
										try {
											const oldFilter = isPreview
												? `label=com.docker.compose.service=${imageId}`
												: `label=coolify.applicationId=${applicationId}`;
											const { stdout: containers } = await executeCommand({
												dockerId: destinationDockerId,
												command: `docker ps -a --filter '${oldFilter}' --format {{.Names}}`
											});
											oldContainerNames = (containers || '')
												.split('\n')
												.map((c) => c.trim())
												.filter(Boolean);
										} catch (error) {
											//
										}
										let envs = [];
										if (secrets.length > 0) {
											envs = [...envs, ...generateSecrets(secrets, pullmergeRequestId, false, port)];
										}
										if (dockerRegistry) {
											const { url, username, password } = dockerRegistry;
											await saveDockerRegistryCredentials({ url, username, password, workdir });
										}
										try {
											const composeVolumes = volumes
												.filter((v) => {
													if (
														!v.startsWith('.') &&
														!v.startsWith('..') &&
														!v.startsWith('/') &&
														!v.startsWith('~')
													) {
														return v;
													}
												})
												.map((volume) => {
													return {
														[`${volume.split(':')[0]}`]: {
															name: volume.split(':')[0]
														}
													};
												});
											const composeFile = {
												version: '3.8',
												services: {
													[newContainerName]: {
														image: imageFound,
														container_name: newContainerName,
														volumes,
														environment: envs,
														labels,
														depends_on: [],
														expose: [port],
														...(exposePort ? { ports: [`${exposePort}:${port}`] } : {}),
														...defaultComposeConfiguration(destinationDocker.network)
													}
												},
												networks: {
													[destinationDocker.network]: {
														external: true
													}
												},
												volumes: Object.assign({}, ...composeVolumes)
											};
											const zdComposeFile = `${workdir}/docker-compose.zd.yml`;
											await fs.writeFile(zdComposeFile, yaml.dump(composeFile));
											const canOverlap = !isPreview && !exposePort;
											if (canOverlap) {
												await executeCommand({
													debug,
													dockerId: destinationDocker.id,
													command: `docker compose --project-directory ${workdir} -p ${buildId} -f ${zdComposeFile} up -d`
												});
												await saveBuildLog({
													line: `Rolling update: started ${newContainerName}, waiting for readiness...`,
													buildId,
													applicationId
												});
												const ready = await waitForAppReady({
													dockerId: destinationDockerId,
													network: destinationDocker.network,
													containerName: newContainerName,
													port
												});
												if (!ready) {
													throw new Error(
														`Replacement container ${newContainerName} did not become ready; keeping the running deployment.`
													);
												}
												await setZdActiveContainer(applicationId, newContainerName);
												await saveBuildLog({
													line: `Rolling update: ${newContainerName} is ready, switching traffic...`,
													buildId,
													applicationId
												});
												await zdSleep(7000);
												for (const oldContainer of oldContainerNames) {
													if (oldContainer === newContainerName) continue;
													try {
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker stop -t 15 ${oldContainer}`
														});
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker rm ${oldContainer}`
														});
														await saveBuildLog({
															line: `Rolling update: removed previous container ${oldContainer}`,
															buildId,
															applicationId
														});
													} catch (error) {
														//
													}
												}
											} else {
												for (const oldContainer of oldContainerNames) {
													if (oldContainer === newContainerName) continue;
													try {
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker stop -t 0 ${oldContainer}`
														});
														await executeCommand({
															dockerId: destinationDockerId,
															command: `docker rm --force ${oldContainer}`
														});
													} catch (error) {
														//
													}
												}
												await executeCommand({
													debug,
													dockerId: destinationDocker.id,
													command: `docker compose --project-directory ${workdir} -p ${buildId} -f ${zdComposeFile} up -d`
												});
											}
											await saveBuildLog({ line: 'Deployed 🎉', buildId, applicationId });
										} catch (error) {
											await saveBuildLog({ line: error, buildId, applicationId });
											const foundBuild = await prisma.build.findUnique({ where: { id: buildId } });
											if (foundBuild) {
												await prisma.build.update({
													where: { id: buildId },
													data: {
														status: 'failed'
													}
												});
											}
											throw new Error(error);
										}
										if (!pullmergeRequestId)
											await prisma.application.update({
												where: { id: applicationId },
												data: { configHash: currentHash }
											});
									}
								}
							} catch (error) {
								const foundBuild = await prisma.build.findUnique({ where: { id: buildId } });
								if (foundBuild) {
									await prisma.build.update({
										where: { id: buildId },
										data: {
											status: 'failed'
										}
									});
								}
								if (error !== 1) {
									await saveBuildLog({ line: error, buildId, applicationId: application.id });
								}
								if (error instanceof Error) {
									await saveBuildLog({
										line: error.message,
										buildId,
										applicationId: application.id
									});
								}
								if (!isDev) await fs.rm(workdir, { recursive: true, force: true });
								return;
							}
							try {
								if (application.dockerRegistryImageName && !pullAuthoritative && (!imageFoundRemotely || forceRebuild)) {
									await saveBuildLog({
										line: `Pushing ${imageName}:${customTag} to Docker Registry... It could take a while...`,
										buildId,
										applicationId: application.id
									});
									await pushToRegistry(application, workdir, tag, imageName, customTag);
									await saveBuildLog({ line: 'Success', buildId, applicationId: application.id });
								}
							} catch (error) {
								if (error.stdout) {
									await saveBuildLog({ line: error.stdout, buildId, applicationId });
								}
								if (error.stderr) {
									await saveBuildLog({ line: error.stderr, buildId, applicationId });
								}
							} finally {
								if (!isDev) await fs.rm(workdir, { recursive: true, force: true });
								await prisma.build.update({ where: { id: buildId }, data: { status: 'success' } });
							}
						});
					}
					await pAll.default(actions, { concurrency });
				}
			} catch (error) {
				console.log(error);
			}
		});
		while (true) {
			await th();
		}
	} else process.exit(0);
})();
