import { executeCommand } from './common';

export function formatLabelsOnDocker(data) {
	return data.trim().split('\n').map(a => JSON.parse(a)).map((container) => {
		const labels = container.Labels.split(',')
		let jsonLabels = {}
		labels.forEach(l => {
			const name = l.split('=')[0]
			const value = l.split('=')[1]
			jsonLabels = { ...jsonLabels, ...{ [name]: value } }
		})
		container.Labels = jsonLabels;
		return container
	})
}
export async function checkContainer({ dockerId, container, remove = false }: { dockerId: string, container: string, remove?: boolean }): Promise<{ found: boolean, name?: string, status?: { isExited: boolean, isRunning: boolean, isRestarting: boolean } }> {
	let target = container;
	let containerFound = false;
	try {
		await executeCommand({
			dockerId,
			command:
				`docker inspect --format '{{json .State}}' ${container}`
		});
		containerFound = true;
	} catch (err) {
		// A rolling (zero-downtime) deploy renames the container to <applicationId>-<buildId>.
		// Fall back to any container Coolify launched for this application.
		target = await resolveContainerName({ dockerId, container });
		containerFound = target !== container;
	}
	if (containerFound) {
		try {
			const { stdout } = await executeCommand({
				dockerId,
				command:
					`docker inspect --format '{{json .State}}' ${target}`
			});
			const parsedStdout = JSON.parse(stdout);
			const status = parsedStdout.Status;
			const isRunning = status === 'running';
			const isRestarting = status === 'restarting';
			const isExited = status === 'exited';
			if (status === 'created') {
				await executeCommand({
					dockerId,
					command:
						`docker rm ${target}`
				});
			}
			if (remove && status === 'exited') {
				await executeCommand({
					dockerId,
					command:
						`docker rm ${target}`
				});
			}
			return {
				found: true,
				name: target,
				status: {
					isRunning,
					isRestarting,
					isExited
				}
			};
		} catch (err) {
			// Container not found
		}
	}
	return {
		found: false
	};
}

export async function resolveContainerName({ dockerId, container }: { dockerId: string, container: string }): Promise<string> {
	try {
		await executeCommand({ dockerId, command: `docker inspect ${container}` });
		return container;
	} catch (err) {
		//
	}
	try {
		const { stdout } = await executeCommand({
			dockerId,
			command: `docker ps -a --filter "label=coolify.applicationId=${container}" --format "{{.Names}}|{{.State}}"`
		});
		const lines = (stdout || '')
			.trim()
			.split('\n')
			.filter((line) => line.length > 0);
		if (lines.length > 0) {
			const running = lines.find((line) => line.endsWith('|running'));
			return (running || lines[0]).split('|')[0];
		}
	} catch (err) {
		//
	}
	return container;
}

export async function isContainerExited(dockerId: string, containerName: string): Promise<boolean> {
	let isExited = false;
	try {
		const { stdout } = await executeCommand({ dockerId, command: `docker inspect -f '{{.State.Status}}' ${containerName}` })
		if (stdout.trim() === 'exited') {
			isExited = true;
		}
	} catch (error) {
		//
	}

	return isExited;
}

export async function removeContainer({
	id,
	dockerId
}: {
	id: string;
	dockerId: string;
}): Promise<void> {
	try {
		const { stdout } = await executeCommand({ dockerId, command: `docker inspect --format '{{json .State}}' ${id}` })
		if (JSON.parse(stdout).Running) {
			await executeCommand({ dockerId, command: `docker stop -t 0 ${id}` })
			await executeCommand({ dockerId, command: `docker rm ${id}` })
		}
		if (JSON.parse(stdout).Status === 'exited') {
			await executeCommand({ dockerId, command: `docker rm ${id}` })
		}
	} catch (error) {
		throw error;
	}
}
