#!/usr/bin/env bash

set -euo pipefail

worker_channel=development
push=false
print_images=false
requested_runtime=""

usage() {
	printf 'Usage: %s [--preview | --production] [--runtime <cu128|cu130>] [--push | --print-images]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--preview)
			if [[ $worker_channel != development ]]; then
				usage
				exit 2
			fi
			worker_channel=preview
			;;
		--production)
			if [[ $worker_channel != development ]]; then
				usage
				exit 2
			fi
			worker_channel=production
			;;
		--push)
			push=true
			;;
		--print-images)
			print_images=true
			;;
		--runtime)
			shift
			if [[ $# -eq 0 ]]; then
				usage
				exit 2
			fi
			requested_runtime="$1"
			;;
		*)
			usage
			exit 2
			;;
	esac
	shift
done

if $push && $print_images; then
	usage
	exit 2
fi
if [[ -n $requested_runtime && $requested_runtime != cu128 && $requested_runtime != cu130 ]]; then
	usage
	exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"

branch=""
if [[ $worker_channel == development ]]; then
	branch="$(git -C "$repo_root" branch --show-current)"
	if [[ -z $branch ]]; then
		printf 'Refusing to derive image tags from a detached HEAD. Check out a branch first.\n' >&2
		exit 1
	fi
fi

if [[ $worker_channel != development ]]; then
	metadata="$(bun -e '
		const manifest = await Bun.file(process.argv[1]).json();
		if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
			console.error("The Worker package version must be a technical semantic version.");
			process.exit(1);
		}
		if (typeof manifest.buildNumber !== "string" || !/^[1-9]\d*$/.test(manifest.buildNumber)) {
			console.error("The Worker build number must be a positive integer string.");
			process.exit(1);
		}
		if (!Number.isSafeInteger(Number(manifest.buildNumber))) {
			console.error("The Worker build number exceeds JavaScript safe integer range.");
			process.exit(1);
		}
		process.stdout.write(manifest.buildNumber);
	' "$repo_root/apps/worker/package.json")"
	build_number="$metadata"
	source_revision="${KASTARD_SOURCE_REVISION:-}"
	if [[ ! $source_revision =~ ^[0-9a-f]{40}$ ]]; then
		printf 'KASTARD_SOURCE_REVISION must be a full Git commit SHA.\n' >&2
		exit 1
	fi
	short_revision="${source_revision:0:7}"
	if [[ $worker_channel == preview ]]; then
		product_version=""
		base_tag="preview-build.${build_number}-${short_revision}"
	else
		product_version="${KASTARD_PRODUCT_VERSION:-}"
		if [[ ! $product_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			printf 'KASTARD_PRODUCT_VERSION must be a stable semantic version in Production.\n' >&2
			exit 1
		fi
		base_tag="${product_version}-build.${build_number}-${short_revision}"
	fi
else
	product_version=""
	source_revision=""
	branch_tag="$(
		printf '%s' "$branch" |
			LC_ALL=C tr '[:upper:]' '[:lower:]' |
			LC_ALL=C sed -E 's/[^a-z0-9_.-]+/-/g; s/^[.-]+//; s/[.-]+$//; s/-+/-/g' |
			LC_ALL=C cut -c1-114 |
			LC_ALL=C sed -E 's/[.-]+$//'
	)"
	if [[ -z $branch_tag ]]; then
		printf 'The branch name cannot be converted to a valid Docker tag.\n' >&2
		exit 1
	fi

	short_sha="$(git -C "$repo_root" rev-parse HEAD | LC_ALL=C cut -c1-7)"
	base_tag="${branch_tag}-${short_sha}"
fi

runtimes=(cu128 cu130)
if [[ -n $requested_runtime ]]; then
	runtimes=("$requested_runtime")
fi
images=()
for runtime in "${runtimes[@]}"; do
	if [[ $worker_channel != development ]]; then
		image="somecatco/kastard-worker-${runtime}:${base_tag}"
	else
		image="ssinss/kastard-worker:${base_tag}-${runtime}"
	fi
	if [[ ! $image =~ ^[a-zA-Z0-9_./-]+:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; then
		printf 'The Worker metadata cannot be converted to a valid Docker image: %s\n' "$image" >&2
		exit 1
	fi
	images+=("$image")
done

print_image_pairs() {
	local index
	for index in "${!runtimes[@]}"; do
		printf '%s\t%s\n' "${runtimes[$index]}" "${images[$index]}"
	done
}

registry_image_exists() {
	local image="$1"
	local error
	if error="$(docker manifest inspect -- "$image" 2>&1)"; then
		return 0
	fi
	if [[ $error == *"manifest unknown"* || $error == *"no such manifest"* ]]; then
		return 1
	fi
	printf '%s\n' "$error" >&2
	return 2
}

if $print_images; then
	print_image_pairs
	exit 0
fi

cd "$repo_root"
bun scripts/worker-runtime-layers.mjs --check
for index in "${!runtimes[@]}"; do
	runtime="${runtimes[$index]}"
	manifest="vendor/comfyui-worker-runtime-${runtime}.json"
	runtime_metadata="$(bun -e '
		const manifest = await Bun.file(process.argv[1]).json();
		const expectedProfile = process.argv[2];
		if (
			manifest.profile !== expectedProfile ||
			typeof manifest.cudaImage !== "string" ||
			manifest.cudaImage.length === 0 ||
			typeof manifest.pythonVersion !== "string" ||
			manifest.pythonVersion.length === 0
		) {
			console.error(`Invalid Worker runtime manifest for ${expectedProfile}.`);
			process.exit(1);
		}
		process.stdout.write(`${manifest.cudaImage}\t${manifest.pythonVersion}`);
	' "$manifest" "$runtime")"
	IFS=$'\t' read -r cuda_image python_version <<< "$runtime_metadata"
	runtime_fingerprint="$(bun scripts/worker-runtime-layers.mjs --fingerprint "$runtime")"
	repository="${images[$index]%:*}"
	runtime_image="${repository}:runtime-${runtime}-${runtime_fingerprint}"
	runtime_cache="${repository}:buildcache-runtime-${runtime}"
	worker_cache="${repository}:buildcache-worker-${runtime}"
	use_registry_cache=false
	if [[ ${GITHUB_ACTIONS:-} == true ]]; then
		use_registry_cache=true
	fi

	if $push; then
		if registry_image_exists "$runtime_image"; then
			printf 'Reusing Worker runtime image %s.\n' "$runtime_image"
		else
			status=$?
			if [[ $status -ne 1 ]]; then exit "$status"; fi
			runtime_build=(
				docker buildx build
				--progress=plain
				--provenance=false
				--platform linux/amd64
				--build-arg "CUDA_IMAGE=${cuda_image}"
				--build-arg "PYTHON_VERSION=${python_version}"
				--build-arg "WORKER_RUNTIME=${runtime}"
			)
			if $use_registry_cache; then
				runtime_build+=(
					--build-arg "CLEAN_UV_CACHE=true"
					--cache-from "type=registry,ref=${runtime_cache}"
					--cache-to "type=registry,ref=${runtime_cache},mode=max"
				)
			fi
			runtime_build+=(
				-f apps/worker/Dockerfile.runtime
				-t "$runtime_image"
				--push
				.
			)
			"${runtime_build[@]}"
		fi

		worker_tags=(-t "${images[$index]}")
		if [[ $worker_channel == production ]]; then
			worker_tags+=(-t "${repository}:latest")
		fi
		worker_build=(
			docker buildx build
			--progress=plain
			--provenance=false
			--platform linux/amd64
			--build-arg "RUNTIME_IMAGE=${runtime_image}"
			--build-arg "KASTARD_CHANNEL=${worker_channel}"
			--build-arg "KASTARD_PRODUCT_VERSION=${product_version}"
			--build-arg "KASTARD_SOURCE_REVISION=${source_revision}"
		)
		if $use_registry_cache; then
			worker_build+=(
				--cache-from "type=registry,ref=${worker_cache}"
				--cache-to "type=registry,ref=${worker_cache},mode=max"
			)
		fi
		worker_build+=(
			-f apps/worker/Dockerfile
			"${worker_tags[@]}"
			--push
			.
		)
		"${worker_build[@]}"
	else
		if ! docker image inspect "$runtime_image" >/dev/null 2>&1; then
			docker build \
				--platform linux/amd64 \
				--build-arg "CUDA_IMAGE=${cuda_image}" \
				--build-arg "PYTHON_VERSION=${python_version}" \
				--build-arg "WORKER_RUNTIME=${runtime}" \
				-f apps/worker/Dockerfile.runtime \
				-t "$runtime_image" \
				.
		fi
		docker build \
			--platform linux/amd64 \
			--build-arg "RUNTIME_IMAGE=${runtime_image}" \
			--build-arg "KASTARD_CHANNEL=${worker_channel}" \
			--build-arg "KASTARD_PRODUCT_VERSION=${product_version}" \
			--build-arg "KASTARD_SOURCE_REVISION=${source_revision}" \
			-f apps/worker/Dockerfile \
			-t "${images[$index]}" \
			.
	fi
done

printf '\n'
print_image_pairs
