import {Descriptor, FetchResult, Installer, Linker, LinkOptions, LinkType, Locator, LocatorHash, MinimalLinkOptions, Package, structUtils} from '@yarnpkg/core';
import {Filename, LinkStrategy, PortablePath, ppath, xfs}                                                                                  from '@yarnpkg/fslib';
import {Dirent}                                                                                                                            from 'fs';

export class PnpmLinker implements Linker {
  supportsPackage(pkg: Package, opts: MinimalLinkOptions) {
    return opts.project.configuration.get(`nodeLinker`) === `pnpm`;
  }

  async findPackageLocation(locator: Locator, opts: LinkOptions) {
    return null as any;
  }

  async findPackageLocator(location: PortablePath, opts: LinkOptions) {
    return null as any;
  }

  makeInstaller(opts: LinkOptions) {
    return new PnpmInstaller(opts);
  }
}

class PnpmInstaller implements Installer {
  private locations = new Map<LocatorHash, PortablePath>();
  private pendingCopies: Array<Promise<void>> = [];

  constructor(private opts: LinkOptions) {
    // Nothing to do
  }

  getCustomDataKey() {
    return JSON.stringify({
      name: `PnpmInstaller`,
      version: 1,
    });
  }

  private customData: {} = {};

  attachCustomData(customData: any) {
    this.customData = customData;
  }

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    switch (pkg.linkType) {
      case LinkType.SOFT: return this.installPackageSoft(pkg, fetchResult);
      case LinkType.HARD: return this.installPackageHard(pkg, fetchResult);
    }

    throw new Error(`Assertion failed: Unsupported package link type`);
  }

  async installPackageSoft(pkg: Package, fetchResult: FetchResult) {
    const pkgPath = ppath.resolve(fetchResult.packageFs.getRealPath(), fetchResult.prefixPath);
    this.locations.set(pkg.locatorHash, pkgPath);

    return {
      packageLocation: pkgPath,
      buildDirective: null,
    };
  }

  async installPackageHard(pkg: Package, fetchResult: FetchResult) {
    const pkgKey = structUtils.slugifyLocator(pkg);

    const pkgPath = ppath.join(this.opts.project.cwd, Filename.nodeModules, `.store` as Filename, pkgKey);
    this.locations.set(pkg.locatorHash, pkgPath);

    this.pendingCopies.push(Promise.resolve().then(async () => {
      await xfs.mkdirPromise(pkgPath, {recursive: true});
      await xfs.copyPromise(pkgPath, fetchResult.prefixPath, {
        baseFs: fetchResult.packageFs,
        overwrite: false,
      });
    }));

    return {
      packageLocation: pkgPath,
      buildDirective: null,
    };
  }

  async attachInternalDependencies(locator: Locator, dependencies: Array<[Descriptor, Locator]>) {
    await Promise.all(this.pendingCopies);

    if (!this.isPnpmVirtualCompatible(locator))
      return;

    const pkgPath = this.locations.get(locator.locatorHash);
    if (typeof pkgPath === `undefined`)
      throw new Error(`Assertion failed: Expected the package to have been registered (${structUtils.stringifyLocator(locator)})`);

    const nmPath = ppath.join(pkgPath, Filename.nodeModules);
    await xfs.mkdirpPromise(nmPath);

    const extraneous = new Map<PortablePath, Dirent>();
    try {
      for (const entry of await xfs.readdirPromise(nmPath, {withFileTypes: true})) {
        if (entry.name.startsWith(`.`))
          continue;

        if (entry.name.startsWith(`@`)) {
          for (const subEntry of await xfs.readdirPromise(ppath.join(nmPath, entry.name), {withFileTypes: true})) {
            extraneous.set(`${entry.name}/${subEntry.name}` as PortablePath, subEntry);
          }
        } else {
          extraneous.set(entry.name, entry);
        }
      }
    } catch (err) {
      if (err.code !== `ENOENT`) {
        throw err;
      }
    }

    for (const [descriptor, dependency] of dependencies) {
      const targetDependency = this.isPnpmVirtualCompatible(dependency)
        ? dependency
        : structUtils.devirtualizeLocator(dependency);

      const depSrcPath = this.locations.get(targetDependency.locatorHash);
      if (typeof depSrcPath === `undefined`)
        throw new Error(`Assertion failed: Expected the package to have been registered (${structUtils.stringifyLocator(dependency)})`);

      const name = structUtils.stringifyIdent(descriptor) as PortablePath;
      const depDstPath = ppath.join(nmPath, name);

      const depLinkPath = ppath.relative(ppath.dirname(depDstPath), depSrcPath);

      const existing = extraneous.get(name);
      extraneous.delete(name);

      if (existing) {
        if (existing.isSymbolicLink() && await xfs.readlinkPromise(depDstPath) === depLinkPath) {
          continue;
        } else {
          await xfs.removePromise(depDstPath);
        }
      }

      await xfs.mkdirpPromise(ppath.dirname(depDstPath));
      await xfs.symlinkPromise(depLinkPath, depDstPath);
    }

    for (const name of extraneous.keys()) {
      await xfs.removePromise(ppath.join(nmPath, name));
    }
  }

  async attachExternalDependents(locator: Locator, dependentPaths: Array<PortablePath>) {
    throw new Error(`External dependencies haven't been implemented for the pnpm linker`);
  }

  async finalizeInstall() {
    if (this.opts.project.configuration.get(`nodeLinker`) !== `pnpm`)
      return undefined;

    return null as any;
  }

  private isPnpmVirtualCompatible(locator: Locator) {
    return !structUtils.isVirtualLocator(locator) || !this.opts.project.tryWorkspaceByLocator(locator);
  }
}