import { create, invalidator, destroy, diffProperty } from '../vdom';
import { Resource, ResourceOptions, ResourceQuery, TransformConfig } from '../resource';
import { Invalidator } from '../interfaces';

type Query = { [key: string]: string | undefined };

export interface Options {
	pageNumber?: number;
	query?: Query;
	pageSize?: number;
}

interface OptionsWrapper {
	getOptions(invalidator: Invalidator): Options;
	setOptions(newOptions: Options, invalidator: Invalidator): void;
}

interface ResourceWrapper {
	resource: Resource;
	createOptionsWrapper(): OptionsWrapper;
	transformer: any;
}

interface ResourceWithData {
	resource: Resource;
	transform: any;
	data: any[];
}

export type ResourceOrResourceWrapper = Resource | ResourceWrapper | ResourceWithData;

export interface DataTransformProperties<T = void> {
	resource: T extends infer R ? { resource: Resource<R, T>; transform: any; data: any } : any;
}

export interface DataInitialiserOptions {
	reset?: boolean;
	resource?: ResourceOrResourceWrapper;
	key?: string;
}

function isResource(resourceWrapperOrResource: any): resourceWrapperOrResource is Resource {
	return !!(resourceWrapperOrResource as any).getOrRead;
}

function createOptionsWrapper(): OptionsWrapper {
	let options: Options = {};

	const invalidators = new Set<Invalidator>();

	function invalidate() {
		[...invalidators].forEach((invalidator) => {
			invalidator();
		});
	}

	return {
		setOptions(newOptions: Options, invalidator: Invalidator) {
			invalidators.add(invalidator);
			if (newOptions !== options) {
				options = newOptions;
				invalidate();
			}
		},
		getOptions(invalidator: Invalidator) {
			invalidators.add(invalidator);
			return options;
		}
	};
}

function createResourceWrapper(resource: Resource, transformer?: any, options?: OptionsWrapper): ResourceWrapper {
	return {
		resource,
		transformer,
		createOptionsWrapper: options ? () => options : createOptionsWrapper
	};
}

function isResourceWithData(resource: any): resource is ResourceWithData {
	return resource && !!resource.data;
}

function createResourceOptions(options: Options, resource: any): ResourceOptions {
	if (options.query) {
		let query: ResourceQuery[] = [];
		if (resource.transform) {
			query = transformQuery(options.query, resource.transform);
		} else {
			query = transformQuery(options.query);
		}
		return {
			...options,
			query
		};
	} else {
		return options as ResourceOptions;
	}
}

function transformQuery<T>(query: Query, transformConfig?: TransformConfig<T>): ResourceQuery[] {
	return Object.keys(query).map((key: string) => {
		if (!transformConfig) {
			return { value: query[key], keys: [key] };
		} else {
			const destinationValues = transformConfig[key as keyof T];
			if (destinationValues) {
				return { value: query[key], keys: destinationValues };
			} else {
				return { value: query[key], keys: [key] };
			}
		}
	});
}

function transformData<T>(item: any, transformConfig: TransformConfig<T>) {
	let transformedItem: Partial<T> = {};
	Object.keys(transformConfig).forEach((key: string) => {
		const sourceValues = transformConfig[key as keyof T];
		if (sourceValues) {
			if (sourceValues.length === 1) {
				transformedItem = {
					...transformedItem,
					[key]: item[sourceValues[0]]
				};
			} else {
				const transformedValues: string | undefined[] = sourceValues.map((value) => item[value]);
				transformedItem = {
					...transformedItem,
					[key]: transformedValues.join(' ')
				};
			}
		}
	});
	return transformedItem;
}

export function createDataMiddleware<T = void>() {
	const factory = create({ invalidator, destroy, diffProperty }).properties<DataTransformProperties<T>>();

	const data = factory(({ middleware: { invalidator, destroy, diffProperty }, properties }) => {
		const optionsWrapperMap = new Map<Resource, Map<string, OptionsWrapper>>();
		const resourceWithDataMap = new Map<T[], Resource>();
		const {
			resource: { transform }
		} = properties();

		destroy(() => {
			[...optionsWrapperMap.keys()].forEach((resource) => {
				resource.unsubscribe(invalidator);
			});
		});

		diffProperty('resource', properties, ({ resource: currentResource }, { resource: nextResource }) => {
			if (isResourceWithData(currentResource) && isResourceWithData(nextResource)) {
				if (
					nextResource.data !== currentResource.data ||
					nextResource.data.length !== currentResource.data.length
				) {
					resourceWithDataMap.delete(nextResource.data);
					invalidator();
				}
			}
			return nextResource;
		});

		return (dataOptions: DataInitialiserOptions = {}) => {
			let passedResourceProperty = dataOptions.resource || properties().resource;
			let resourceWrapperOrResource;

			if (isResourceWithData(passedResourceProperty)) {
				const { resource, data } = passedResourceProperty;
				if (!resourceWithDataMap.has(data)) {
					resourceWithDataMap.set(data, resource);
					resource.set(data);
				}
				resourceWrapperOrResource = resourceWithDataMap.get(data);
			} else {
				resourceWrapperOrResource = passedResourceProperty;
			}

			let resourceWrapper: ResourceWrapper;

			if (isResource(resourceWrapperOrResource)) {
				resourceWrapper = createResourceWrapper(resourceWrapperOrResource, transform);
			} else {
				resourceWrapper = resourceWrapperOrResource as ResourceWrapper;
			}

			if (dataOptions.reset) {
				resourceWrapper = createResourceWrapper(resourceWrapper.resource, transform);
			}

			const { resource } = resourceWrapper;
			const { key = '' } = dataOptions;

			let keyedCachedOptions = optionsWrapperMap.get(resource);
			if (!keyedCachedOptions) {
				keyedCachedOptions = new Map<string, OptionsWrapper>();
			}

			let cachedOptions = keyedCachedOptions.get(key);
			let optionsWrapper: OptionsWrapper;

			if (cachedOptions) {
				optionsWrapper = cachedOptions;
			} else {
				const newOptionsWrapper = resourceWrapper.createOptionsWrapper();
				keyedCachedOptions.set(key, newOptionsWrapper);
				optionsWrapperMap.set(resource, keyedCachedOptions);
				optionsWrapper = newOptionsWrapper;
			}

			return {
				getOrRead(options: Options): T extends void ? any : T[] | undefined {
					const { resource: resourceContainer } = properties();
					const { transform, resource } = resourceContainer;

					const resourceOptions = createResourceOptions(options, resourceContainer);

					resource.subscribe('data', resourceOptions, invalidator);

					const data = resource.getOrRead(resourceOptions);

					if (data && data.length && transform) {
						return data.map((item: any) => transformData(item, transform));
					}

					return data;
				},
				get(options: Options): T extends void ? any : T[] | undefined {
					const { resource: resourceContainer } = properties();
					const { transform, resource } = resourceContainer;

					const resourceOptions = createResourceOptions(options, resourceContainer);

					const data = resource.get(resourceOptions);

					if (data && data.length && transform) {
						return data.map((item: any) => transformData(item, transform));
					}

					return data;
				},
				getTotal(options: Options) {
					const { resource: resourceContainer } = properties();
					const { resource } = resourceContainer;

					const resourceOptions = createResourceOptions(options, resourceContainer);

					resource.subscribe('total', resourceOptions, invalidator);
					return resource.getTotal(resourceOptions);
				},
				isLoading(options: Options) {
					const { resource: resourceContainer } = properties();
					const { resource } = resourceContainer;

					const resourceOptions = createResourceOptions(options, resourceContainer);

					resource.subscribe('loading', resourceOptions, invalidator);
					return resource.isLoading(resourceOptions);
				},
				isFailed(options: Options) {
					const { resource: resourceContainer } = properties();
					const { resource } = resourceContainer;

					const resourceOptions = createResourceOptions(options, resourceContainer);

					resource.subscribe('failed', resourceOptions, invalidator);
					return resource.isFailed(resourceOptions);
				},
				setOptions(newOptions: Options) {
					optionsWrapper.setOptions(newOptions, invalidator);
				},
				getOptions() {
					return optionsWrapper.getOptions(invalidator);
				},
				get resource() {
					return resourceWrapper;
				},
				shared() {
					return createResourceWrapper(resource, transform, optionsWrapper);
				}
			};
		};
	});
	return data;
}

export const data = createDataMiddleware();

export default data;
