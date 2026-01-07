const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        
        // TIEMPOS DE ESPERA LARGOS (Por seguridad en servidor gratis)
        page.setDefaultNavigationTimeout(60000); // 60 segundos
        page.setDefaultTimeout(60000);

        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN (URL CORREGIDA: portal.defontana.com)
        console.log('Entrando al Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        // Esperamos que cargue el formulario
        // Nota: Asumimos que los selectores de correo/pass son los mismos. 
        // Si fallara aquí, tendríamos que revisar si en "portal" se llaman diferente.
        await page.waitForSelector('input[formcontrolname="email"]');
        
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        console.log('Enviando credenciales...');
        
        // Click en entrar y esperamos
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('Login OK. Buscando acceso al ERP...');

        // 2. ABRIR EL ERP (Detectar nueva pestaña)
        // Buscamos el botón/enlace que abre el ERP. Usualmente dice "ERP Digital" o es un ícono.
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        
        // Esperamos a que el botón aparezca
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        // Preparamos la captura de la nueva ventana que se abrirá
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        
        // Click para abrir el ERP
        await erpButton.click();
        console.log('Abriendo ERP (Nueva pestaña)...');
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        if (!erpPage) throw new Error("No se detectó la nueva pestaña del ERP");

        // Configuramos la nueva pestaña
        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        // Esperamos un poco a que la nueva pestaña inicialice (cargue Angular)
        await erpPage.waitForNavigation({ waitUntil: 'domcontentloaded' });

        // 3. NAVEGACIÓN DIRECTA (El truco maestro)
        // En vez de clics, vamos directo a la URL de Artículos
        console.log('Saltando directo a Artículos...');
        const urlInventario = 'https://erp.defontana.com/#/Inventario/Inventario/Articulos';
        
        // Forzamos la navegación en la pestaña del ERP
        await erpPage.goto(urlInventario, { waitUntil: 'networkidle2' }); // Networkidle es mejor aquí para asegurar que cargue la tabla

        console.log('Módulo de Artículos cargado. Buscando...');

        // 4. BÚSQUEDA DEL PRODUCTO
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        
        // Esperamos que aparezca el buscador
        await erpPage.waitForSelector(searchInputSelector);
        
        // Escribimos y buscamos
        await erpPage.type(searchInputSelector, skuLimpio);
        await erpPage.keyboard.press('Enter');

        // 5. EXTRACCIÓN (Igual que antes)
        try {
            await erpPage.waitForSelector('.mat-column-id', { timeout: 10000 });
        } catch (e) {
            console.log('Tiempo de espera de tabla agotado (posiblemente sin resultados).');
        }

        const resultado = await erpPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            if (filas.length === 0) return null;

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                // Usamos "includes" por si el SKU tiene variaciones, o "===" para exacto
                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR:', error);
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
